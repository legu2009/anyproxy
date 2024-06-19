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

const { CommonReadableStream,
  getErrorResponse,
  fetchRemoteResponse,
  getWsReqInfo,
  getUserReqHandler } = require('.requestHandle_util');
/**
 * get a handler for CONNECT request
 *
 * @param {RequestHandler} reqHandlerCtx
 * @param {object} userRule
 * @param {Recorder} recorder
 * @param {object} httpsServerMgr
 * @returns
 */
function getConnectReqHandler(recorder, httpsServerMgr) {
  const reqHandlerCtx = this;
  reqHandlerCtx.conns = new Map();
  reqHandlerCtx.cltSockets = new Map();
  const userRule = reqHandlerCtx.userRule;
  return function (req, cltSocket, head) {
    const host = req.url.split(':')[0],
      targetPort = req.url.split(':')[1];
    let shouldIntercept;
    let interceptWsRequest = false;
    let requestDetail;
    let resourceInfo = null;
    let resourceInfoId = -1;
    const requestStream = new CommonReadableStream();

    /*
      1. write HTTP/1.1 200 to client
      2. get request data
      3. tell if it is a websocket request
      4.1 if (websocket || do_not_intercept) --> pipe to target server
      4.2 else --> pipe to local server and do man-in-the-middle attack
    */
    co(function* () {
      // determine whether to use the man-in-the-middle server
      logUtil.printLog(color.green('received https CONNECT request ' + host));
      requestDetail = {
        host: req.url,
        _req: req
      };
      // the return value in default rule is null
      // so if the value is null, will take it as final value
      shouldIntercept = yield userRule.beforeDealHttpsRequest(requestDetail);

      // otherwise, will take the passed in option
      if (shouldIntercept === null) {
        shouldIntercept = reqHandlerCtx.forceProxyHttps;
      }
    })
      .then(() => {
        return new Promise((resolve) => {
          // mark socket connection as established, to detect the request protocol
          cltSocket.write('HTTP/' + req.httpVersion + ' 200 OK\r\n\r\n', 'UTF-8', resolve);
        });
      })
      .then(() => {
        return new Promise((resolve, reject) => {
          let resolved = false;
          cltSocket.on('data', (chunk) => {
            requestStream.push(chunk);
            if (!resolved) {
              resolved = true;
              try {
                const chunkString = chunk.toString();
                if (chunkString.indexOf('GET ') === 0) {
                  shouldIntercept = false; // websocket, do not intercept

                  // if there is '/do-not-proxy' in the request, do not intercept the websocket
                  // to avoid AnyProxy itself be proxied
                  if (reqHandlerCtx.wsIntercept && chunkString.indexOf('GET /do-not-proxy') !== 0) {
                    interceptWsRequest = true;
                  }
                }
              } catch (e) {
                console.error(e);
              }
              resolve();
            }
          });
          cltSocket.on('error', (error) => {
            logUtil.printLog(util.collectErrorLog(error), logUtil.T_ERR);
            co.wrap(function* () {
              try {
                yield userRule.onClientSocketError(requestDetail, error);
              } catch (e) { }
            });
          });
          cltSocket.on('end', () => {
            requestStream.push(null);
          });
        });
      })
      .then((result) => {
        // log and recorder
        if (shouldIntercept) {
          logUtil.printLog('will forward to local https server');
        } else {
          logUtil.printLog('will bypass the man-in-the-middle proxy');
        }

        //record
        if (recorder) {
          resourceInfo = {
            host,
            method: req.method,
            path: '',
            url: 'https://' + host,
            req,
            startTime: new Date().getTime()
          };
          resourceInfoId = recorder.appendRecord(resourceInfo);
        }
      })
      .then(() => {
        // determine the request target
        if (!shouldIntercept) {
          // server info from the original request
          const originServer = {
            host,
            port: (targetPort === 80) ? 443 : targetPort
          }

          const localHttpServer = {
            host: 'localhost',
            port: reqHandlerCtx.httpServerPort
          }

          // for ws request, redirect them to local ws server
          return interceptWsRequest ? localHttpServer : originServer;
        } else {
          return httpsServerMgr.getSharedHttpsServer(host).then(serverInfo => ({ host: serverInfo.host, port: serverInfo.port }));
        }
      })
      .then((serverInfo) => {
        if (!serverInfo.port || !serverInfo.host) {
          throw new Error('failed to get https server info');
        }

        return new Promise((resolve, reject) => {
          const conn = net.connect(serverInfo.port, serverInfo.host, () => {
            //throttle for direct-foward https
            if (global._throttle && !shouldIntercept) {
              requestStream.pipe(conn);
              conn.pipe(global._throttle.throttle()).pipe(cltSocket);
            } else {
              requestStream.pipe(conn);
              conn.pipe(cltSocket);
            }

            resolve();
          });

          conn.on('error', (e) => {
            reject(e);
          });

          reqHandlerCtx.conns.set(serverInfo.host + ':' + serverInfo.port, conn)
          reqHandlerCtx.cltSockets.set(serverInfo.host + ':' + serverInfo.port, cltSocket)
        });
      })
      .then(() => {
        if (recorder) {
          resourceInfo.endTime = new Date().getTime();
          resourceInfo.statusCode = '200';
          resourceInfo.resHeader = {};
          resourceInfo.resBody = '';
          resourceInfo.length = 0;

          recorder && recorder.updateRecord(resourceInfoId, resourceInfo);
        }
      })
      .catch(co.wrap(function* (error) {
        logUtil.printLog(util.collectErrorLog(error), logUtil.T_ERR);

        try {
          yield userRule.onConnectError(requestDetail, error);
        } catch (e) { }

        try {
          let errorHeader = 'Proxy-Error: true\r\n';
          errorHeader += 'Proxy-Error-Message: ' + (error || 'null') + '\r\n';
          errorHeader += 'Content-Type: text/html\r\n';
          cltSocket.write('HTTP/1.1 502\r\n' + errorHeader + '\r\n\r\n');
        } catch (e) { }
      }));
  }
}

/**
* get a websocket event handler
  @param @required {object} wsClient
*/
function getWsHandler(recorder, wsClient, wsReq) {
  const reqHandlerCtx = this;
  const userRule = reqHandlerCtx.userRule;
  try {
    let resourceInfoId = -1;
    const resourceInfo = {
      wsMessages: [] // all ws messages go through AnyProxy
    };
    const clientMsgQueue = [];
    let serverInfo = null;
    if (userRule.beforeWsClient) {
      serverInfo = userRule.beforeWsClient(getWsReqInfo(wsReq));
    } else {
      serverInfo = getWsReqInfo(wsReq);
    }
    const serverInfoPort = serverInfo.port ? `:${serverInfo.port}` : '';
    const wsUrl = `${serverInfo.protocol}://${serverInfo.hostName}${serverInfoPort}${serverInfo.path}`;
    const proxyWs = new WebSocket(wsUrl, '', {
      rejectUnauthorized: !reqHandlerCtx.dangerouslyIgnoreUnauthorized,
      headers: serverInfo.noWsHeaders
    });

    if (recorder) {
      Object.assign(resourceInfo, {
        host: serverInfo.hostName,
        method: 'WebSocket',
        path: serverInfo.path,
        url: wsUrl,
        req: wsReq,
        startTime: new Date().getTime()
      });
      resourceInfoId = recorder.appendRecord(resourceInfo);
    }

    /**
    * store the messages before the proxy ws is ready
    */
    const sendProxyMessage = (event) => {
      const message = event.data;
      if (proxyWs.readyState === 1) {
        // if there still are msg queue consuming, keep it going
        if (clientMsgQueue.length > 0) {
          clientMsgQueue.push(message);
        } else {
          proxyWs.send(message);
        }
      } else {
        clientMsgQueue.push(message);
      }
    }

    /**
    * consume the message in queue when the proxy ws is not ready yet
    * will handle them from the first one-by-one
    */
    const consumeMsgQueue = () => {
      while (clientMsgQueue.length > 0) {
        const message = clientMsgQueue.shift();
        proxyWs.send(message);
      }
    }

    /**
    * When the source ws is closed, we need to close the target websocket.
    * If the source ws is normally closed, that is, the code is reserved, we need to transfrom them
    */
    const getCloseFromOriginEvent = (event) => {
      const code = event.code || '';
      const reason = event.reason || '';
      let targetCode = '';
      let targetReason = '';
      if (code >= 1004 && code <= 1006) {
        targetCode = 1000; // normal closure
        targetReason = `Normally closed. The origin ws is closed at code: ${code} and reason: ${reason}`;
      } else {
        targetCode = code;
        targetReason = reason;
      }

      return {
        code: targetCode,
        reason: targetReason
      }
    }

    /**
    * consruct a message Record from message event
    * @param @required {event} messageEvent the event from websockt.onmessage
    * @param @required {boolean} isToServer whether the message is to or from server
    *
    */
    const recordMessage = (messageEvent, isToServer) => {
      const message = {
        time: Date.now(),
        message: messageEvent.data,
        isToServer: isToServer
      };

      // resourceInfo.wsMessages.push(message);
      recorder && recorder.updateRecordWsMessage(resourceInfoId, message);
    };

    proxyWs.onopen = () => {
      consumeMsgQueue();
    }

    // this event is fired when the connection is build and headers is returned
    proxyWs.on('upgrade', (response) => {
      resourceInfo.endTime = new Date().getTime();
      const headers = response.headers;
      resourceInfo.res = { //construct a self-defined res object
        statusCode: response.statusCode,
        headers: headers,
      };

      resourceInfo.statusCode = response.statusCode;
      resourceInfo.resHeader = headers;
      resourceInfo.resBody = '';
      resourceInfo.length = resourceInfo.resBody.length;

      recorder && recorder.updateRecord(resourceInfoId, resourceInfo);
    });

    proxyWs.onerror = (e) => {
      // https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent#Status_codes
      wsClient.close(1001, e.message);
      proxyWs.close(1001);
    }

    proxyWs.onmessage = (event) => {
      recordMessage(event, false);
      wsClient.readyState === 1 && wsClient.send(event.data);
    }

    proxyWs.onclose = (event) => {
      logUtil.debug(`proxy ws closed with code: ${event.code} and reason: ${event.reason}`);
      const targetCloseInfo = getCloseFromOriginEvent(event);
      wsClient.readyState !== 3 && wsClient.close(targetCloseInfo.code, targetCloseInfo.reason);
    }

    wsClient.onmessage = (event) => {
      recordMessage(event, true);
      sendProxyMessage(event);
    }

    wsClient.onclose = (event) => {
      logUtil.debug(`original ws closed with code: ${event.code} and reason: ${event.reason}`);
      const targetCloseInfo = getCloseFromOriginEvent(event);
      proxyWs.readyState !== 3 && proxyWs.close(targetCloseInfo.code, targetCloseInfo.reason);
    }
  } catch (e) {
    logUtil.debug('WebSocket Proxy Error:' + e.message);
    logUtil.debug(e.stack);
    console.error(e);
  }
}

class RequestHandler {
  /**
   * Creates an instance of RequestHandler.
   *
   * @param {object} config
   * @param {boolean} config.forceProxyHttps proxy all https requests
   * @param {boolean} config.dangerouslyIgnoreUnauthorized
     @param {number} config.httpServerPort  the http port AnyProxy do the proxy
   * @param {object} rule
   * @param {Recorder} recorder
   *
   * @memberOf RequestHandler
   */
  constructor(config, rule, recorder) {
    const reqHandlerCtx = this;
    this.forceProxyHttps = false;
    this.dangerouslyIgnoreUnauthorized = false;
    this.httpServerPort = '';
    this.wsIntercept = false;
    this.ruleFilePath = config.ruleFilePath;
    this._proxyServer = config._proxyServer;

    if (config.forceProxyHttps) {
      this.forceProxyHttps = true;
    }

    if (config.dangerouslyIgnoreUnauthorized) {
      this.dangerouslyIgnoreUnauthorized = true;
    }

    if (config.wsIntercept) {
      this.wsIntercept = config.wsIntercept;
    }

    this.httpServerPort = config.httpServerPort;
    const default_rule = util.freshRequire('./rule_default');
    const userRule = util.merge(default_rule, rule);

    reqHandlerCtx.userRule = userRule;

    reqHandlerCtx.userRequestHandler = getUserReqHandler.apply(reqHandlerCtx, [recorder]);
    reqHandlerCtx.wsHandler = getWsHandler.bind(reqHandlerCtx, recorder);

    reqHandlerCtx.httpsServerMgr = new HttpsServerMgr({
      handler: reqHandlerCtx.userRequestHandler,
      wsHandler: reqHandlerCtx.wsHandler, // websocket
      hostname: '127.0.0.1',
    });

    this.connectReqHandler = getConnectReqHandler.apply(reqHandlerCtx, [recorder, reqHandlerCtx.httpsServerMgr]);
  }
}

module.exports = RequestHandler;
