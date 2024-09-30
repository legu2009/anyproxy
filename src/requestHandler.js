'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const zlib = require('zlib');
const { Buffer } = require('buffer');
const util = require('./util');
const logUtil = require('./log');
const WebSocket = require('ws');
const HttpsServerMgr = require('./httpsServerMgr');
const brotliTorb = require('brotli');
const chalk = require('chalk');
const requestErrorHandler = require('./requestErrorHandler');


// 修复TLS缓存问题,参考: https://github.com/nodejs/node/issues/8368
https.globalAgent.maxCachedSessions = 0;

/*
* 获取异常场景的错误响应
*/
const getErrorResponse = (error, detailInfo) => {
    // 默认错误响应
    const fullUrl = detailInfo.reqInfo.url;
    return {
        statusCode: 500,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Proxy-Error': true,
            'Proxy-Error-Message': error ? JSON.stringify(error) : 'null'
        },
        body: requestErrorHandler.getErrorContent(error, fullUrl)
    };
}


function fetchRemoteResponse(detailInfo) {
    return new Promise((resolve, reject) => {
        const { reqInfo, dangerouslyIgnoreUnauthorized } = detailInfo;
        const urlPattern = new URL(reqInfo.url);
        const headers = reqInfo.headers;
        // 处理请求头
        if (urlPattern.method !== 'DELETE') {
            delete headers['content-length']; // 删除content-length头，稍后会重新设置
            delete headers['Content-Length'];
        } else if (requestData) {
            headers['Content-Length'] = Buffer.byteLength(reqInfo.body);
        }

        delete headers['Transfer-Encoding'];
        delete headers['transfer-encoding'];

        headers['Host'] = urlPattern.host;
        headers['Origin'] = urlPattern.origin;

        let options = {
            method: reqInfo.method,
            headers: headers,
            url: reqInfo.url,
            rejectUnauthorized: !dangerouslyIgnoreUnauthorized,
        }
        // 发送请求
        const proxyReq = (/https/i.test(urlPattern.protocol) ? https : http).request(reqInfo.url, options, (res) => {
            res.headers = util.getHeaderFromRawHeaders(res.rawHeaders);
            const statusCode = res.statusCode;
            const headers = res.headers;

            detailInfo.rawResInfo = {
                headers,
                statusCode,
                body: null
            }

            detailInfo.resInfo = {
                headers: { ...headers },
                statusCode
            }
            detailInfo.res = res;

            // 原始响应块
            if (detailInfo.waitResData === false) {
                resolve();
                return;
            }

            res.on('error', (error) => {
                logUtil.printLog('响应中发生错误:' + error, logUtil.T_ERR);
                reject(error);
            });
            // 处理响应数据
            let rawResChunks = [];
            res.on('data', (chunk) => {
                rawResChunks.push(chunk);
            });
            res.on('end', () => {
                const serverResData = Buffer.concat(rawResChunks);
                detailInfo.rawResInfo.body = serverResData;
                if (detailInfo.resInfo.body === undefined) {
                    detailInfo.resInfo.body = detailInfo.rawResInfo.body;
                }
                const originContentLen = util.getByteSize(serverResData);
                const headers = detailInfo.resInfo.headers;
                // 处理内容编码
                const contentEncoding = headers['content-encoding'] || headers['Content-Encoding'];
                const ifServerGzipped = /gzip/i.test(contentEncoding);
                const isServerDeflated = /deflate/i.test(contentEncoding);
                const isBrotlied = /br/i.test(contentEncoding);

                // 更新头部内容编码
                const refactContentEncoding = () => {
                    if (contentEncoding) {
                        headers['x-anyproxy-origin-content-encoding'] = contentEncoding;
                        delete headers['content-encoding'];
                        delete headers['Content-Encoding'];
                    }
                };

                // 设置原始内容长度
                headers['x-anyproxy-origin-content-length'] = originContentLen;

                // 解压响应数据
                if (ifServerGzipped && originContentLen) {
                    refactContentEncoding();
                    zlib.gunzip(serverResData, (err, buff) => {
                        err ? reject(err) : detailInfo.resInfo.body = buff, resolve();
                    });
                } else if (isServerDeflated && originContentLen) {
                    refactContentEncoding();
                    zlib.inflate(serverResData, (err, buff) => {
                        err ? reject(err) : detailInfo.resInfo.body = buff, resolve();
                    });
                } else if (isBrotlied && originContentLen) {
                    refactContentEncoding();
                    try {
                        detailInfo.resInfo.body = Buffer.from(brotliTorb.decompress(serverResData));
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    resolve();
                }
            });
        });

        proxyReq.on('error', reject);
        if (detailInfo.waitReqData === false) {
            detailInfo.req.pipe(proxyReq);
        } else {
            proxyReq.end(detailInfo.reqInfo.body);
        }
    });
}

function getNoWsHeaders(headers) {
    const noWsHeaders = {};
    for (const key in headers) {
        if (!/sec-websocket/ig.test(key) && !['connection', 'upgrade'].includes(key)) {
            noWsHeaders[key] = headers[key];
        }
    }
    return noWsHeaders;
}
function getWsReqInfo(wsReq) {
    const headers = wsReq.headers || {};
    const host = headers.host;
    const [hostName, port] = host.split(':');
    const path = wsReq.url || '/';
    const isEncript = wsReq.connection && wsReq.connection.encrypted;
    return {
        headers: headers, // 原始ws连接的完整头部
        noWsHeaders: getNoWsHeaders(headers),
        hostName: hostName,
        port: port,
        path: path,
        protocol: isEncript ? 'wss' : 'ws'
    };
}


function _wsHandler(wsClient, wsReq) {
    const proxyRule = this.proxyRule;
    try {
        const clientMsgQueue = [];
        let serverInfo = getWsReqInfo(wsReq);
        proxyRule.beforeWsClient(serverInfo);
        const serverInfoPort = serverInfo.port ? `:${serverInfo.port}` : '';
        const wsUrl = `${serverInfo.protocol}://${serverInfo.hostName}${serverInfoPort}${serverInfo.path}`;

        const proxyWs = new WebSocket(wsUrl, undefined, {
            rejectUnauthorized: !this.dangerouslyIgnoreUnauthorized,
            headers: serverInfo.noWsHeaders
        });

        proxyWs.onopen = () => {
            while (clientMsgQueue.length > 0) {
                proxyWs.send(clientMsgQueue.shift());
            }
        }
        // 当连接建立并返回头部时触发此事件
        proxyWs.on('upgrade', (response) => {
            console.log('proxyWs onupgrade');
        });

        proxyWs.onerror = (e) => {
            // https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent#Status_codes
            wsClient.close(1001, e.message);
            proxyWs.close(1001);
        }

        proxyWs.onmessage = (event) => {
            wsClient.readyState === 1 && wsClient.send(event.data);
        }

        proxyWs.onclose = (event) => {
            logUtil.debug(`代理ws以代码: ${event.code} 和原因: ${event.reason} 关闭`);
            const targetCloseInfo = getCloseFromOriginEvent(event);
            wsClient.readyState !== 3 && wsClient.close(targetCloseInfo.code, targetCloseInfo.reason);
        }

        wsClient.onclose = (event) => {
            logUtil.debug(`原始ws以代码: ${event.code} 和原因: ${event.reason} 关闭`);
            const targetCloseInfo = getCloseFromOriginEvent(event);
            proxyWs.readyState !== 3 && proxyWs.close(targetCloseInfo.code, targetCloseInfo.reason);
        }

        wsClient.onmessage = (event) => {
            const message = event.data;
            if (proxyWs.readyState === 1) {
                // 如果仍在消费消息队列，继续进行
                if (clientMsgQueue.length > 0) {
                    clientMsgQueue.push(message);
                } else {
                    proxyWs.send(message);
                }
            } else {
                clientMsgQueue.push(message);
            }
        }

    } catch (e) {
        logUtil.debug('WebSocket Proxy Error:' + e.message);
        logUtil.debug(e.stack);
        console.error(e);
    }
}


/**
* 当源ws关闭时，我们需要关闭目标websocket。
* 如果源ws正常关闭，即代码是保留的，我们需要转换它们
*/
function getCloseFromOriginEvent(event) {
    const code = event.code || '';
    const reason = event.reason || '';
    let targetCode = '';
    let targetReason = '';
    if (code >= 1004 && code <= 1006) {
        targetCode = 1000; // 正常关闭
        targetReason = `正常关闭。原始ws以代码: ${code} 和原因: ${reason} 关闭`;
    } else {
        targetCode = code;
        targetReason = reason;
    }

    return {
        code: targetCode,
        reason: targetReason
    }
}

async function _requestHandler(req, userRes) {
    const proxyRule = this.proxyRule;

    const host = req.headers.host;
    const protocol = (!!req.connection.encrypted && !(/^http:/).test(req.url)) ? 'https' : 'http';
    const fullUrl = protocol + '://' + host + req.url;
    const urlPattern = new URL(fullUrl);
    if (this.systemRequest(urlPattern, userRes)) {
        return;
    }
    req.headers = util.getHeaderFromRawHeaders(req.rawHeaders);
    let detailInfo = {
        rawReqInfo: {
            method: req.method,
            url: fullUrl,
            headers: req.headers,
            body: null,
            startTime: new Date().getTime()
        },
        reqInfo: {
            method: req.method,
            url: fullUrl,
            headers: req.headers,
            startTime: new Date().getTime()
        },
        rawResInfo: {

        },
        resInfo: {

        },
        req: req,
        res: null,
        waitReqData: false,
        waitResData: false,
        dangerouslyIgnoreUnauthorized: this.dangerouslyIgnoreUnauthorized
    };

    //recorder
    logUtil.printLog(chalk.green(`收到请求: ${req.method} ${fullUrl}`));
    try {
        await proxyRule.isWaitReqData(detailInfo.reqInfo, detailInfo);
        // 获取请求数据
        detailInfo.waitReqData ? await getReqData(detailInfo) : getReqData(detailInfo);
        // 调用规则处理请求
        await proxyRule.beforeSendRequest(detailInfo.reqInfo, detailInfo);
        // 处理响应
        if (detailInfo.resInfo.statusCode !== undefined) {
            detailInfo.waitResData = true;
        } else {
            await fetchRemoteResponse(detailInfo);
            await proxyRule.beforeSendResponse(detailInfo.resInfo, detailInfo)
        }
        // 发送最终响应
    } catch (error) {
        logUtil.printLog(util.collectErrorLog(error), logUtil.T_ERR);
        detailInfo.resInfo = getErrorResponse(error, detailInfo);
        detailInfo.waitResData = true;
        // 调用用户规则处理错误
        try {
            await proxyRule.onError(error, detailInfo)
        } catch (e) { }
    }

    try {
        await sendFinalResponse(detailInfo, userRes, this);
        //recorder
    } catch (error) {
        console.log(error);
        logUtil.printLog(chalk.green('发送最终响应失败:' + error.message), logUtil.T_ERR);
    }
}

function getReqData(detailInfo) {
    return new Promise((resolve) => {
        const body = [];
        const req = detailInfo.req;
        req.on('data', (chunk) => {
            body.push(chunk);
        });
        req.on('end', () => {
            detailInfo.rawReqInfo.body = Buffer.concat(body);
            if (detailInfo.reqInfo.body === undefined) {
                detailInfo.reqInfo.body = detailInfo.rawReqInfo.body;
            }
            //recorder && recorder.updateRecord
            resolve();
        });
    });
}

function sendFinalResponse(detailInfo, userRes, ctx) {
    const { res, waitResData, resInfo } = detailInfo;
    if (!waitResData) {
        userRes.writeHead(resInfo.statusCode, resInfo.headers);
        if (ctx._throttle) {
            res.pipe(ctx._throttle.throttle()).pipe(userRes);
        } else {
            res.pipe(userRes);
        }
        return;
    }

    const headers = resInfo.headers;
    const transferEncoding = headers['transfer-encoding'] || headers['Transfer-Encoding'] || '';
    const contentLength = headers['content-length'] || headers['Content-Length'];
    const connection = headers.Connection || headers.connection;
    if (contentLength) {
        delete headers['content-length'];
        delete headers['Content-Length'];
    }

    // 设置代理连接
    if (connection) {
        headers['x-anyproxy-origin-connection'] = connection;
        delete headers.connection;
        delete headers.Connection;
    }

    if (!resInfo) {
        throw new Error('获取响应信息失败');
    } else if (!resInfo.statusCode) {
        throw new Error('获取响应状态码失败')
    } else if (!resInfo.headers) {
        throw new Error('获取响应头失败');
    }
    // 如果没有传输编码，设置内容长度
    if (!ctx._throttle && transferEncoding !== 'chunked') {
        headers['Content-Length'] = util.getByteSize(resInfo.body);
    }
    userRes.writeHead(resInfo.statusCode, headers);
    if (ctx._throttle) {
        const thrStream = new Stream();
        thrStream.pipe(this._throttle.throttle()).pipe(userRes);
        thrStream.emit('data', resInfo.body);
        thrStream.emit('end');
    } else {
        userRes.end(resInfo.body);
    }
}

class RequestHandler {
    constructor(config, proxyServer) {
        this.dangerouslyIgnoreUnauthorized = !!config.dangerouslyIgnoreUnauthorized;
        this.httpServerPort = config.httpServerPort || '';
        this.wsIntercept = !!config.wsIntercept;
        this.proxyServer = proxyServer;
        this._throttle = proxyServer._throttle;
        this.recorder = false;
        this.serverSockets = new Map();
        this.clientSockets = new Map();

        // 获取用户请求处理器
        this.requestHandler = _requestHandler.bind(this);
        // 获取WebSocket处理器
        this.wsHandler = _wsHandler.bind(this);

        // 创建HTTPS服务器管理器
        this.httpsServerMgr = new HttpsServerMgr({
            requestHandler: this.requestHandler,
            wsHandler: this.wsHandler, // WebSocket处理器
            hostname: '127.0.0.1',
        });

        // 获取连接请求处理器
        this.connectReqHandler = this.connectReqHandler.bind(this);
    }


    async connectReqHandler(req, clientSocket, head) {
        const [host, port] = req.url.split(':');
        const proxyRule = this.proxyRule;
        const connectDetail = { host, port, req };
        logUtil.printLog(chalk.green(`收到HTTPS CONNECT请求: ${req.url}`));

        let interceptWsRequest = false; //本地wss对接客户端ws
        try {
            let shouldIntercept = true;
            if (await proxyRule.isDealHttpsRequest(connectDetail) === false) {
                shouldIntercept = false
            }
            logUtil.printLog(shouldIntercept ? '将转发到本地HTTPS服务器' : '将绕过中间人代理');

            //ws直接转发，不支持转发到本地的ws服务上
            let serverInfo = interceptWsRequest ? {
                host: 'localhost',
                port: this.httpServerPort
            } : { host: host, port: port || 80 };

            if (shouldIntercept) {
                let sharedHttpsServer = await this.httpsServerMgr.getSharedHttpsServer(host);
                serverInfo = { host: sharedHttpsServer.host, port: sharedHttpsServer.port };
            }

            const serverSocket = net.connect(serverInfo.port, serverInfo.host, () => {
                clientSocket.write('HTTP/' + req.httpVersion + ' 200 OK\r\n\r\n', 'UTF-8');
                if (this._throttle && shouldIntercept) {
                    clientSocket.pipe(serverSocket);
                    serverSocket.pipe(this._throttle.throttle()).pipe(clientSocket);
                } else {
                    clientSocket.pipe(serverSocket);
                    serverSocket.pipe(clientSocket);
                }
            });
            this.serverSockets.set(`${serverInfo.host}:${serverInfo.port}`, serverSocket);
            this.clientSockets.set(`${serverInfo.host}:${serverInfo.port}`, clientSocket);
            //recorder
        } catch (error) {
            logUtil.printLog(util.collectErrorLog(error), logUtil.T_ERR);
            try {
                await proxyRule.onConnectError(error, connectDetail);
                const errorHeader = [
                    'Proxy-Error: true',
                    `Proxy-Error-Message: ${error || 'null'}`,
                    'Content-Type: text/html'
                ].join('\r\n');
                clientSocket.write(`HTTP/1.1 502\r\n${errorHeader}\r\n\r\n`);
            } catch (e) { }
        }

    }
    systemRequest(urlPattern, userRes) {
        if (urlPattern.pathname === '/__anyproxy/user_rule') {
            userRes.writeHead(200, {});
            userRes.end('refresh user_rule');
            this.proxyServer.reloadProxyRule();
            return true;
        }

        if (urlPattern.pathname === '/__anyproxy/close') {
            userRes.writeHead(200, {});
            userRes.end('__anyproxy close');
            if (this.proxyServer) {
                try {
                    this.proxyServer.close();
                    this.proxyServer = null;
                } catch (e) {
                    console.error(e);
                }
            }
            return true;
        }
    }


    get proxyRule() {
        return this.proxyServer.proxyRule;
    }

}

module.exports = RequestHandler;
