'use strict';

const http = require('http'),
  https = require('https'),
  net = require('net'),
  url = require('url'),
  zlib = require('zlib'),
  color = require('colorful'),
  Buffer = require('buffer').Buffer,
  util = require('./util'),
  Stream = require('stream'),
  logUtil = require('./log'),
  co = require('co'),
  WebSocket = require('ws'),
  HttpsServerMgr = require('./httpsServerMgr'),
  brotliTorb = require('brotli'),
  Readable = require('stream').Readable;

const requestErrorHandler = require('./requestErrorHandler');

// to fix issue with TLS cache, refer to: https://github.com/nodejs/node/issues/8368
https.globalAgent.maxCachedSessions = 0;

const DEFAULT_CHUNK_COLLECT_THRESHOLD = 20 * 1024 * 1024; // about 20 mb

class CommonReadableStream extends Readable {
  constructor(config) {
    super({
      highWaterMark: DEFAULT_CHUNK_COLLECT_THRESHOLD * 5
    });
  }
  _read(size) {

  }
}

/*
* get error response for exception scenarios
*/
const getErrorResponse = (error, fullUrl) => {
  // default error response
  const errorResponse = {
    statusCode: 500,
    header: {
      'Content-Type': 'text/html; charset=utf-8',
      'Proxy-Error': true,
      'Proxy-Error-Message': error ? JSON.stringify(error) : 'null'
    },
    body: requestErrorHandler.getErrorContent(error, fullUrl)
  };

  return errorResponse;
}

/**
 * fetch remote response
 *
 * @param {string} protocol
 * @param {object} options options of http.request
 * @param {buffer} reqData request body
 * @param {object} config
 * @param {boolean} config.dangerouslyIgnoreUnauthorized
 * @param {boolean} config.chunkSizeThreshold
 * @returns
 */
function fetchRemoteResponse(protocol, options, reqData, config) {
  reqData = reqData || '';
  return new Promise((resolve, reject) => {
    if (options.method !== 'DELETE') {
      delete options.headers['content-length']; // will reset the content-length after rule
      delete options.headers['Content-Length'];
    } else {
      if (reqData) {
        options.headers['Content-Length'] = reqData.length
      }
    }
    
    delete options.headers['Transfer-Encoding'];
    delete options.headers['transfer-encoding'];

    if (config.dangerouslyIgnoreUnauthorized) {
      options.rejectUnauthorized = false;
    }

    if (!config.chunkSizeThreshold) {
      throw new Error('chunkSizeThreshold is required');
    }
    //send request
    const proxyReq = (/https/i.test(protocol) ? https : http).request(options, (res) => {
      res.headers = util.getHeaderFromRawHeaders(res.rawHeaders);
      //deal response header
      const statusCode = res.statusCode;
      const resHeader = res.headers;
      let resDataChunks = []; // array of data chunks or stream
      const rawResChunks = []; // the original response chunks
      let resDataStream = null;
      let resSize = 0;
      const finishCollecting = () => {
        new Promise((fulfill, rejectParsing) => {
          if (resDataStream) {
            fulfill(resDataStream);
          } else {
            const serverResData = Buffer.concat(resDataChunks);
            const originContentLen = util.getByteSize(serverResData);
            // remove gzip related header, and ungzip the content
            // note there are other compression types like deflate
            const contentEncoding = resHeader['content-encoding'] || resHeader['Content-Encoding'];
            const ifServerGzipped = /gzip/i.test(contentEncoding);
            const isServerDeflated = /deflate/i.test(contentEncoding);
            const isBrotlied = /br/i.test(contentEncoding);

            /**
             * when the content is unzipped, update the header content
             */
            const refactContentEncoding = () => {
              if (contentEncoding) {
                resHeader['x-anyproxy-origin-content-encoding'] = contentEncoding;
                delete resHeader['content-encoding'];
                delete resHeader['Content-Encoding'];
              }
            }

            // set origin content length into header
            resHeader['x-anyproxy-origin-content-length'] = originContentLen;

            // only do unzip when there is res data
            if (ifServerGzipped && originContentLen) {
              refactContentEncoding();
              zlib.gunzip(serverResData, (err, buff) => {
                if (err) {
                  rejectParsing(err);
                } else {
                  fulfill(buff);
                }
              });
            } else if (isServerDeflated && originContentLen) {
              refactContentEncoding();
              zlib.inflate(serverResData, (err, buff) => {
                if (err) {
                  rejectParsing(err);
                } else {
                  fulfill(buff);
                }
              });
            } else if (isBrotlied && originContentLen) {
              refactContentEncoding();

              try {
                // an Unit8Array returned by decompression
                const result = brotliTorb.decompress(serverResData);
                fulfill(Buffer.from(result));
              } catch (e) {
                rejectParsing(e);
              }
            } else {
              fulfill(serverResData);
            }
          }
        }).then((serverResData) => {
          resolve({
            statusCode,
            header: resHeader,
            body: serverResData,
            rawBody: rawResChunks,
            _res: res,
          });
        }).catch((e) => {
          reject(e);
        });
      };

      if (config._directlyRemoteResponse === true) {
        resolve({
          statusCode,
          header: resHeader,
          body: null,
          rawBody: null,
          _res: res,
        })
        return;
      }

      //deal response data
      res.on('data', (chunk) => {
        rawResChunks.push(chunk);
        if (resDataStream) { // stream mode
          resDataStream.push(chunk);
        } else { // dataChunks
          resSize += chunk.length;
          resDataChunks.push(chunk);

          // stop collecting, convert to stream mode
          if (resSize >= config.chunkSizeThreshold) {
            resDataStream = new CommonReadableStream();
            while (resDataChunks.length) {
              resDataStream.push(resDataChunks.shift());
            }
            resDataChunks = null;
            finishCollecting();
          }
        }
      });

      res.on('end', () => {
        if (resDataStream) {
          resDataStream.push(null); // indicate the stream is end
          finishCollecting();
        } else {
          finishCollecting();
        }
      });
      res.on('error', (error) => {
        logUtil.printLog('error happend in response:' + error, logUtil.T_ERR);
        reject(error);
      });
    });

    proxyReq.on('error', reject);
    if (config.isFetchReqData === false && !reqData) {
      config._req.pipe(proxyReq);
    } else {
      proxyReq.end(reqData);
    }
  });
}

/**
* get request info from the ws client, includes:
 host
 port
 path
 protocol  ws/wss

 @param @required wsClient the ws client of WebSocket
*
*/
function getWsReqInfo(wsReq) {
  const headers = wsReq.headers || {};
  const host = headers.host;
  const hostName = host.split(':')[0];
  const port = host.split(':')[1];

  // TODO 如果是windows机器，url是不是全路径？需要对其过滤，取出
  const path = wsReq.url || '/';

  const isEncript = wsReq.connection && wsReq.connection.encrypted;
  /**
   * construct the request headers based on original connection,
   * but delete the `sec-websocket-*` headers as they are already consumed by AnyProxy
   */
  const getNoWsHeaders = () => {
    const originHeaders = Object.assign({}, headers);
    const originHeaderKeys = Object.keys(originHeaders);
    originHeaderKeys.forEach((key) => {
      // if the key matchs 'sec-websocket', delete it
      if (/sec-websocket/ig.test(key)) {
        delete originHeaders[key];
      }
    });

    delete originHeaders.connection;
    delete originHeaders.upgrade;
    return originHeaders;
  }


  return {
    headers: headers, // the full headers of origin ws connection
    noWsHeaders: getNoWsHeaders(),
    hostName: hostName,
    port: port,
    path: path,
    protocol: isEncript ? 'wss' : 'ws'
  };
}
/**
 * get a request handler for http/https server
 *
 * @param {RequestHandler} reqHandlerCtx
 * @param {object} userRule
 * @param {Recorder} recorder
 * @returns
 */
function getUserReqHandler(recorder) {
  const reqHandlerCtx = this

  return function (req, userRes) {
    const userRule = reqHandlerCtx.userRule;
    /*
    note
      req.url is wired
      in http  server: http://www.example.com/a/b/c
      in https server: /a/b/c
    */

    const host = req.headers.host;
    const protocol = (!!req.connection.encrypted && !(/^http:/).test(req.url)) ? 'https' : 'http';

    // try find fullurl https://github.com/alibaba/anyproxy/issues/419
    let fullUrl = protocol + '://' + host + req.url;
    if (protocol === 'http') {
      const reqUrlPattern = url.parse(req.url);
      if (reqUrlPattern.host && reqUrlPattern.protocol) {
        fullUrl = req.url;
      }
    }

    const urlPattern = url.parse(fullUrl);
    if (urlPattern.path === '/__anyproxy/user_rule') {
      userRes.writeHead(200, {});
      userRes.end('refresh user_rule');
      if (reqHandlerCtx.ruleFilePath) {
        reqHandlerCtx.userRule = util.merge(util.freshRequire('./rule_default'), util.freshRequire(reqHandlerCtx.ruleFilePath));
      }
      return;
    }

    if (urlPattern.path === '/__anyproxy/close') {
      userRes.writeHead(200, {});
      userRes.end('__anyproxy close');
      if (reqHandlerCtx._proxyServer) {
        try {
          reqHandlerCtx._proxyServer.close();
          reqHandlerCtx._proxyServer = null;
        } catch (e) {
          console.error(e);
        }
        process.exit();  
      }
      return;
    }

    const path = urlPattern.path;
    const chunkSizeThreshold = DEFAULT_CHUNK_COLLECT_THRESHOLD;

    let resourceInfo = null;
    let resourceInfoId = -1;
    let reqData;
    let requestDetail;
    let isFetchReqData = true;

    // refer to https://github.com/alibaba/anyproxy/issues/103
    // construct the original headers as the reqheaders
    req.headers = util.getHeaderFromRawHeaders(req.rawHeaders);

    logUtil.printLog(color.green(`received request to: ${req.method} ${host}${path}`));

    /**
     * fetch complete req data
     */
    const fetchReqData = () => new Promise((resolve) => {
      if (!isFetchReqData) {
        resolve();
      }
      const postData = [];
      req.on('data', (chunk) => {
        postData.push(chunk);
      });
      req.on('end', () => {
        reqData = Buffer.concat(postData);
        resolve();
      });
    });

    /**
     * prepare detailed request info
     */
    const prepareRequestDetail = () => {
      const options = {
        hostname: urlPattern.hostname || req.headers.host,
        port: urlPattern.port || req.port || (/https/.test(protocol) ? 443 : 80),
        path,
        method: req.method,
        headers: req.headers
      };

      requestDetail = {
        requestOptions: options,
        protocol,
        url: fullUrl,
        requestData: reqData,
        _req: req
      };

      return Promise.resolve();
    };

    /**
    * send response to client
    *
    * @param {object} finalResponseData
    * @param {number} finalResponseData.statusCode
    * @param {object} finalResponseData.header
    * @param {buffer|string} finalResponseData.body
    */
    const sendFinalResponse = (finalResponseData) => {
      if (finalResponseData._directlyRemoteResponse && !finalResponseData._directlyPassToRespond) {
        const res = finalResponseData._res;
        userRes.writeHead(res.statusCode, res.headers);
        res.pipe(userRes);
        return;
      }
      const responseInfo = finalResponseData.response;
      const resHeader = responseInfo.header;
      const responseBody = responseInfo.body || '';

      const transferEncoding = resHeader['transfer-encoding'] || resHeader['Transfer-Encoding'] || '';
      const contentLength = resHeader['content-length'] || resHeader['Content-Length'];
      const connection = resHeader.Connection || resHeader.connection;
      if (contentLength) {
        delete resHeader['content-length'];
        delete resHeader['Content-Length'];
      }

      // set proxy-connection
      if (connection) {
        resHeader['x-anyproxy-origin-connection'] = connection;
        delete resHeader.connection;
        delete resHeader.Connection;
      }

      if (!responseInfo) {
        throw new Error('failed to get response info');
      } else if (!responseInfo.statusCode) {
        throw new Error('failed to get response status code')
      } else if (!responseInfo.header) {
        throw new Error('filed to get response header');
      }
      // if there is no transfer-encoding, set the content-length
      if (!global._throttle
        && transferEncoding !== 'chunked'
        && !(responseBody instanceof CommonReadableStream)
      ) {
        resHeader['Content-Length'] = util.getByteSize(responseBody);
      }

      userRes.writeHead(responseInfo.statusCode, resHeader);

      if (global._throttle) {
        if (responseBody instanceof CommonReadableStream) {
          responseBody.pipe(global._throttle.throttle()).pipe(userRes);
        } else {
          const thrStream = new Stream();
          thrStream.pipe(global._throttle.throttle()).pipe(userRes);
          thrStream.emit('data', responseBody);
          thrStream.emit('end');
        }
      } else {
        if (responseBody instanceof CommonReadableStream) {
          responseBody.pipe(userRes);
        } else {
          userRes.end(responseBody);
        }
      }

      return responseInfo;
    }

    // fetch complete request data
    co(prepareRequestDetail)
      .then(co.wrap(function* () {
        if (!userRule.beforeFetchReqData) {
          isFetchReqData = true;
        } else {
          const flag = yield userRule.beforeFetchReqData(Object.assign({}, requestDetail));
          isFetchReqData = flag === false ? false : true;
        }
      }))
      .then(fetchReqData)
      .then(prepareRequestDetail)
      .then(() => {
        // record request info
        if (recorder) {
          resourceInfo = {
            host,
            method: req.method,
            path,
            protocol,
            url: protocol + '://' + host + path,
            req,
            startTime: new Date().getTime()
          };
          resourceInfoId = recorder.appendRecord(resourceInfo);
          try {
            resourceInfo.reqBody = reqData.toString(); //TODO: deal reqBody in webInterface.js
            recorder && recorder.updateRecord(resourceInfoId, resourceInfo);
          } catch (e) { }
        }
      })

      // invoke rule before sending request
      .then(co.wrap(function* () {
        const userModifiedInfo = (yield userRule.beforeSendRequest(Object.assign({}, requestDetail))) || {};
        const finalReqDetail = {};
        ['protocol', 'requestOptions', 'requestData', 'response', '_directlyRemoteResponse'].map((key) => {
          finalReqDetail[key] = userModifiedInfo[key] || requestDetail[key]
        });
        return finalReqDetail;
      }))

      // route user config
      .then(co.wrap(function* (userConfig) {
        if (userConfig.response) {
          // user-assigned local response
          userConfig._directlyPassToRespond = true;
          return userConfig;
        } else if (userConfig.requestOptions) {
          const remoteResponse = yield fetchRemoteResponse(userConfig.protocol, userConfig.requestOptions, userConfig.requestData, {
            dangerouslyIgnoreUnauthorized: reqHandlerCtx.dangerouslyIgnoreUnauthorized,
            chunkSizeThreshold,
            isFetchReqData,
            _req: req,
            _directlyRemoteResponse: userConfig._directlyRemoteResponse
          });
          return {
            response: {
              statusCode: remoteResponse.statusCode,
              header: remoteResponse.header,
              body: remoteResponse.body,
              rawBody: remoteResponse.rawBody
            },
            _directlyRemoteResponse: userConfig._directlyRemoteResponse,
            _res: remoteResponse._res,
          };
        } else {
          throw new Error('lost response or requestOptions, failed to continue');
        }
      }))

      // invoke rule before responding to client
      .then(co.wrap(function* (responseData) {
        if (responseData._directlyPassToRespond) {
          return responseData;
        } else if (responseData.response.body && responseData.response.body instanceof CommonReadableStream) { // in stream mode
          return responseData;
        } else {
          // TODO: err etimeout
          return (yield userRule.beforeSendResponse(Object.assign({}, requestDetail), Object.assign({}, responseData))) || responseData;
        }
      }))

      .catch(co.wrap(function* (error) {
        logUtil.printLog(util.collectErrorLog(error), logUtil.T_ERR);

        let errorResponse = getErrorResponse(error, fullUrl);

        // call user rule
        try {
          const userResponse = yield userRule.onError(Object.assign({}, requestDetail), error);
          if (userResponse && userResponse.response && userResponse.response.header) {
            errorResponse = userResponse.response;
          }
        } catch (e) { }

        return {
          response: errorResponse
        };
      }))
      .then(sendFinalResponse)

      //update record info
      .then((responseInfo) => {
        resourceInfo.endTime = new Date().getTime();
        resourceInfo.res = { //construct a self-defined res object
          statusCode: responseInfo.statusCode,
          headers: responseInfo.header,
        };

        resourceInfo.statusCode = responseInfo.statusCode;
        resourceInfo.resHeader = responseInfo.header;
        resourceInfo.resBody = responseInfo.body instanceof CommonReadableStream ? '(big stream)' : (responseInfo.body || '');
        resourceInfo.length = resourceInfo.resBody.length;

        // console.info('===> resbody in record', resourceInfo);

        recorder && recorder.updateRecord(resourceInfoId, resourceInfo);
      })
      .catch((e) => {
        logUtil.printLog(color.green('Send final response failed:' + e.message), logUtil.T_ERR);
      });
  }
}

module.exports = {
  CommonReadableStream,
  getErrorResponse,
  fetchRemoteResponse,
  getWsReqInfo,
  getUserReqHandler
};
