'use strict'

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
    pug = require('pug'),
    HttpsServerMgr = require('./httpsServerMgr'),
    Readable = require('stream').Readable;

// to fix issue with TLS cache, refer to: https://github.com/nodejs/node/issues/8368
https.globalAgent.maxCachedSessions = 0;

const error502PugFn = pug.compileFile(require('path').join(__dirname, '../resource/502.pug'));
const DEFAULT_CHUNK_COLLECT_THRESHOLD = 20 * 1024 * 1024; // about 20 mb

class CommonReadableStream extends Readable {
    constructor(config) {
        super({
            highWaterMark: DEFAULT_CHUNK_COLLECT_THRESHOLD * 5
        });
    }
    _read(size) {}
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
function fetchRemoteResponse(protocol, options, reqData, config, userReq, userRes) {
    reqData = reqData || '';
    return new Promise((resolve, reject) => {
        delete options.headers['content-length']; // will reset the content-length after rule
        delete options.headers['Content-Length'];
        delete options.headers['Transfer-Encoding'];
        delete options.headers['transfer-encoding'];

        if (config.dangerouslyIgnoreUnauthorized) {
            options.rejectUnauthorized = false;
        }

        if (!config.chunkSizeThreshold) {
            throw new Error('chunkSizeThreshold is required');
        }
        //send request
        const proxyReq = (/https/i.test(protocol) ? https : http).request(options, (proxyRes) => {
            userRes.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(userRes);
        });

        proxyReq.on('error', reject);
        userReq.pipe(proxyReq);
    });
}

/**
 * get a request handler for http/https server
 *
 * @param {RequestHandler} reqHandlerCtx
 * @param {object} userRule
 * @param {Recorder} recorder
 * @returns
 */
function getUserReqHandler(userRule, recorder) {
    const reqHandlerCtx = this

    return function (req, userRes) {
        const host = req.headers.host;
        const protocol = (!!req.connection.encrypted && !(/^http:/).test(req.url)) ? 'https' : 'http';
        const fullUrl = protocol === 'http' ? req.url : (protocol + '://' + host + req.url);

        const urlPattern = url.parse(fullUrl);
        const path = urlPattern.path;
        const chunkSizeThreshold = DEFAULT_CHUNK_COLLECT_THRESHOLD;

        let resourceInfo = null;
        let resourceInfoId = -1;
        let reqData;
        let requestDetail;

        req.headers = util.getHeaderFromRawHeaders(req.rawHeaders);

        logUtil.printLog(color.green(`received request to: ${req.method} ${host}${path}`));

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

        const userModifiedInfo = (userRule.dealProxyOptions(Object.assign({}, requestDetail))) || {};

        const userConfig = {};
        ['protocol', 'requestOptions', 'requestData', 'response'].map((key) => {
            userConfig[key] = userModifiedInfo[key] || requestDetail[key]
        });

        co(co.wrap(function* () {
            if (userConfig.response) {
                userConfig._directlyPassToRespond = true;
                return userConfig;
            } else if (userConfig.requestOptions) {
                yield fetchRemoteResponse(userConfig.protocol, userConfig.requestOptions, userConfig.requestData, {
                    dangerouslyIgnoreUnauthorized: reqHandlerCtx.dangerouslyIgnoreUnauthorized,
                    chunkSizeThreshold,
                }, req, userRes);
            } else {
                throw new Error('lost response or requestOptions, failed to continue');
            }
        }))
        .catch(co.wrap(function* (error) {
            logUtil.printLog(util.collectErrorLog(error), logUtil.T_ERR);

            let content;
            try {
                content = error502PugFn({
                    error,
                    url: fullUrl,
                    errorStack: error.stack.split(/\n/)
                });
            } catch (parseErro) {
                content = error.stack;
            }

            // default error response
            let errorResponse = {
                statusCode: 500,
                header: {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Proxy-Error': true,
                    'Proxy-Error-Message': error || 'null'
                },
                body: content
            };

            // call user rule
            try {
                const userResponse = yield userRule.onError(Object.assign({}, requestDetail), error);
                if (userResponse && userResponse.response && userResponse.response.header) {
                    errorResponse = userResponse.response;
                }
            } catch (e) {}

            return {
                response: errorResponse
            };
        }))
        /*.then(sendFinalResponse)

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
        });*/
    }
}

/**
 * get a handler for CONNECT request
 *
 * @param {RequestHandler} reqHandlerCtx
 * @param {object} userRule
 * @param {Recorder} recorder
 * @param {object} httpsServerMgr
 * @returns
 */
function getConnectReqHandler(userRule, recorder, httpsServerMgr) {
    const reqHandlerCtx = this;
    reqHandlerCtx.conns = new Map();
    reqHandlerCtx.cltSockets = new Map()

    return function (req, cltSocket, head) {
        const host = req.url.split(':')[0],
            targetPort = req.url.split(':')[1];

        let shouldIntercept;
        let requestDetail;
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
                if (reqHandlerCtx.forceProxyHttps) {
                    shouldIntercept = true;
                } else {
                    requestDetail = {
                        host: req.url,
                        _req: req
                    };
                    shouldIntercept = yield userRule.beforeDealHttpsRequest(requestDetail);
                }
            })
            .then(new Promise(resolve => {
                // mark socket connection as established, to detect the request protocol
                cltSocket.write('HTTP/' + req.httpVersion + ' 200 OK\r\n\r\n', 'UTF-8', resolve);
            }))
            .then(new Promise((resolve, reject) => {
                let resolved = false;
                cltSocket.on('data', chunk => {
                    requestStream.push(chunk);
                    if (!resolved) {
                        resolved = true;
                        try {
                            const chunkString = chunk.toString();
                            if (chunkString.indexOf('GET ') === 0) {
                                shouldIntercept = false; //websocket
                            }
                        } catch (e) {}
                        resolve();
                    }
                });
                cltSocket.on('end', () => {
                    requestStream.push(null);
                });
            }))
            .then(() => {
                // log and recorder
                if (shouldIntercept) {
                    logUtil.printLog('will forward to local https server');
                } else {
                    logUtil.printLog('will bypass the man-in-the-middle proxy');
                }

                //record
                // resourceInfo = {
                //   host,
                //   method: req.method,
                //   path: '',
                //   url: 'https://' + host,
                //   req,
                //   startTime: new Date().getTime()
                // };
                // resourceInfoId = recorder.appendRecord(resourceInfo);
            })
            .then(() => {
                // determine the request target
                if (!shouldIntercept) {
                    return {
                        host,
                        port: (targetPort === 80) ? 443 : targetPort,
                    }
                } else {
                    return httpsServerMgr.getSharedHttpsServer().then(serverInfo => ({
                        host: serverInfo.host,
                        port: serverInfo.port
                    }));
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
                // resourceInfo.endTime = new Date().getTime();
                // resourceInfo.statusCode = '200';
                // resourceInfo.resHeader = {};
                // resourceInfo.resBody = '';
                // resourceInfo.length = 0;

                // recorder && recorder.updateRecord(resourceInfoId, resourceInfo);
            })
            .catch(co.wrap(function* (error) {
                logUtil.printLog(util.collectErrorLog(error), logUtil.T_ERR);

                try {
                    yield userRule.onConnectError(requestDetail, error);
                } catch (e) {}

                try {
                    let errorHeader = 'Proxy-Error: true\r\n';
                    errorHeader += 'Proxy-Error-Message: ' + (error || 'null') + '\r\n';
                    errorHeader += 'Content-Type: text/html\r\n';
                    cltSocket.write('HTTP/1.1 502\r\n' + errorHeader + '\r\n\r\n');
                } catch (e) {}
            }));
    }
}

class RequestHandler {

    /**
     * Creates an instance of RequestHandler.
     *
     * @param {object} config
     * @param {boolean} config.forceProxyHttps proxy all https requests
     * @param {boolean} config.dangerouslyIgnoreUnauthorized
     * @param {object} rule
     * @param {Recorder} recorder
     *
     * @memberOf RequestHandler
     */
    constructor(config, rule, recorder) {
        const reqHandlerCtx = this;
        if (config.forceProxyHttps) {
            this.forceProxyHttps = true;
        }
        if (config.dangerouslyIgnoreUnauthorized) {
            this.dangerouslyIgnoreUnauthorized = true;
        }
        const default_rule = util.freshRequire('./rule_default');
        const userRule = util.merge(default_rule, rule);

        reqHandlerCtx.userRequestHandler = getUserReqHandler.apply(reqHandlerCtx, [userRule, recorder]);

        reqHandlerCtx.httpsServerMgr = new HttpsServerMgr({
            handler: reqHandlerCtx.userRequestHandler
        });

        this.connectReqHandler = getConnectReqHandler.apply(reqHandlerCtx, [userRule, recorder, reqHandlerCtx.httpsServerMgr])
    }
}

module.exports = RequestHandler;