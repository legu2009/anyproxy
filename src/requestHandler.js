'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { Buffer } = require('buffer');
const chalk = require('chalk');
const WebSocket = require('ws');

const util = require('./util');
const logUtil = require('./log');
const HttpsServerMgr = require('./httpsServerMgr');
const requestErrorHandler = require('./requestErrorHandler');
const { Stream, Transform, Readable } = require('stream');


const DEFAULT_CHUNK_COLLECT_THRESHOLD = 20 * 1024 * 1024;
// 修复TLS缓存问题,参考: https://github.com/nodejs/node/issues/8368
https.globalAgent.maxCachedSessions = 0;

class ReadableStream extends Readable {
    constructor(config) {
        super({
            highWaterMark: DEFAULT_CHUNK_COLLECT_THRESHOLD * 5
        });
    }
    _read(size) {

    }
}

class BodyTransform extends Transform {
    constructor(callback) {
        super();
        this.callback = callback;
        this.cache = [];
    }

    _transform(chunk, encoding, callback) {
        this.cache.push(chunk);
        this.push(chunk);
        callback();
    }

    _flush(callback) {
        this.callback(Buffer.concat(this.cache));
        callback();
    }

}

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


async function fetchRemoteResponse(detailInfo, ctx) {
    await new Promise((resolve, reject) => {
        const { reqInfo, dangerouslyIgnoreUnauthorized, waitReqData } = detailInfo;
        const urlPattern = new URL(reqInfo.url);
        const headers = reqInfo.headers;
        // 处理请求头
        // if (urlPattern.method !== 'DELETE') {
        //     delete headers['content-length']; // 删除content-length头，稍后会重新设置
        //     delete headers['Content-Length'];
        // } else 


        if (reqInfo.body) {
            headers['Content-Length'] = Buffer.byteLength(reqInfo.body);
        }

        delete headers['Transfer-Encoding'];
        delete headers['transfer-encoding'];

        headers['Host'] = urlPattern.host;

        // 发送请求
        const proxyReq = (/https/i.test(urlPattern.protocol) ? https : http).request(
            reqInfo.url,
            {
                method: reqInfo.method,
                headers: headers,
                rejectUnauthorized: !dangerouslyIgnoreUnauthorized,
            },
            (res) => {
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
                ctx.recorder.updateRawRes(detailInfo);
                // 原始响应块
                res.on('error', (error) => {
                    logUtil.printLog('响应中发生错误:' + error, logUtil.T_ERR);
                    reject(error);
                });
                // 处理响应数据
                resolve();
            }
        );

        proxyReq.on('error', reject);
        if (!waitReqData && reqInfo.body === undefined) {
            detailInfo.req.pipe(proxyReq);
        } else {
            proxyReq.end(reqInfo.body);
        }
        ctx.recorder.updateUserReq(detailInfo);
    });

    const { waitResData } = detailInfo;
    if (waitResData) {
        await getResData(detailInfo, ctx)
    } else {
        getResData(detailInfo, ctx)
    }
}

function getResData(detailInfo, ctx) {
    const { waitResData } = detailInfo;
    return new Promise((resolve) => {
        const body = [];
        const res = detailInfo.res;
        res.on('data', (chunk) => {
            body.push(chunk);
        });
        res.on('end', async () => {
            detailInfo.rawResInfo.body = Buffer.concat(body);
            ctx.recorder.updateRawResBody(detailInfo);
            if (waitResData) {
                detailInfo.resInfo.body = await util.decodingResBody(detailInfo.rawResInfo.body, detailInfo.resInfo.headers);
            }
            resolve();
        });
    });
}

function _getHeaders(headers) {
    const _headers = {};
    for (const key in headers) {
        if (!/sec-websocket/ig.test(key) && !['connection', 'upgrade'].includes(key)) {
            _headers[key] = headers[key];
        }
    }
    return _headers;
}
function getWsReqInfo(wsReq) {
    const headers = wsReq.headers || {};
    const host = headers.host;
    const [hostName, port] = host.split(':');
    const path = wsReq.url || '/';
    const isEncript = wsReq.connection && wsReq.connection.encrypted;
    return {
        rawWsReq: {
            headers: headers, // 原始ws连接的完整头部
            hostName: hostName,
            port: port,
            path: path,
            protocol: isEncript ? 'wss' : 'ws'
        },
        wsReq: {
            headers: _getHeaders(headers),
            hostName: hostName,
            port: port,
            path: path,
            protocol: isEncript ? 'wss' : 'ws'
        }
    };
}


function _connectionListener(wsClient, wsReq) {
    const proxyRule = this.proxyRule;
    try {
        const clientMsgList = [];
        let serverInfo = getWsReqInfo(wsReq);
        proxyRule.beforeWsClient(serverInfo.wsReq, serverInfo);
        const wsReq = serverInfo.wsReq;
        const wsUrl = `${wsReq.protocol}://${wsReq.hostName}${wsReq.port ? `:${wsReq.port}` : ''}${wsReq.path}`;

        const proxyWs = new WebSocket(wsUrl, undefined, {
            rejectUnauthorized: !this.dangerouslyIgnoreUnauthorized,
            headers: serverInfo.headers
        });

        proxyWs.onopen = () => {
            while (clientMsgList.length > 0) {
                proxyWs.send(clientMsgList.shift());
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
                if (clientMsgList.length > 0) {
                    clientMsgList.push(message);
                } else {
                    proxyWs.send(message);
                }
            } else {
                clientMsgList.push(message);
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

async function _requestListener(rawReq, rawRes) {
    const proxyRule = this.proxyRule;
    const recorder = this.recorder;
    const host = rawReq.headers.host;
    const protocol = (!!rawReq.connection.encrypted && !(/^http:/).test(rawReq.url)) ? 'https' : 'http';
    const fullUrl = protocol === 'http' && rawReq.url[0] !== '/' ? rawReq.url : (protocol + '://' + host + rawReq.url);
    const urlPattern = new URL(fullUrl);
    if (this.systemRequest(urlPattern, rawRes)) {
        return;
    }
    if (protocol === 'http' && rawReq.url[0] === '/') {
        return;
    }
    rawReq.headers = util.getHeaderFromRawHeaders(rawReq.rawHeaders);

    let detailInfo = {
        rawReqInfo: {
            method: rawReq.method,
            url: fullUrl,
            headers: rawReq.headers,
            body: null
        },
        reqInfo: {
            host: urlPattern.hostname,
            protocol: protocol,
            port: urlPattern.port,
            method: rawReq.method,
            url: fullUrl,
            headers: rawReq.headers
        },
        rawResInfo: {

        },
        resInfo: {

        },
        req: rawReq,
        res: null,
        clientStartTime: null,
        proxyStartTime: null,
        proxyEndTime: null,
        clientEndTime: null,
        waitReqData: false,
        waitResData: false,
        dealRequest: true,
        dangerouslyIgnoreUnauthorized: this.dangerouslyIgnoreUnauthorized,
        _recorderId: recorder.appendId()
    };

    logUtil.printLog(chalk.green(`收到请求: ${rawReq.method} ${fullUrl}`));
    try {
        recorder.updateRawReq(detailInfo);
        if (await proxyRule.isDealRequest(detailInfo.reqInfo, detailInfo) === false) {
            detailInfo.dealRequest = false;
        }
        const dealRequest = detailInfo.dealRequest;
        if (dealRequest === false) {
            //直接调用远程
            await fetchRemoteResponse(detailInfo, this);
        } else {
            await proxyRule.isWaitReqData(detailInfo.reqInfo, detailInfo);
            let waitReqData = detailInfo.waitReqData;
            if (waitReqData) {
                await getReqData(detailInfo, this);
            } else {
                getReqData(detailInfo, this);
            }
            await proxyRule.beforeSendRequest(detailInfo.reqInfo, detailInfo);
            if (detailInfo.resInfo.statusCode === undefined) {
                await fetchRemoteResponse(detailInfo, this);
                await proxyRule.beforeSendResponse(detailInfo.resInfo, detailInfo);
            }
        }
    } catch (error) {
        logUtil.printLog(util.collectErrorLog(error), logUtil.T_ERR);
        detailInfo.resInfo = getErrorResponse(error, detailInfo);
        try {
            await proxyRule.onError(error, detailInfo)
        } catch (e) { }
    }

    try {
        await sendFinalResponse(detailInfo, rawRes, this);
    } catch (error) {
        logUtil.printLog(chalk.green('发送最终响应失败:' + error.message), logUtil.T_ERR);
    }
}

function getReqData(detailInfo, ctx) {
    return new Promise((resolve) => {
        const body = [];
        const req = detailInfo.req;
        req.on('data', (chunk) => {
            body.push(chunk);
        });
        req.on('end', () => {
            detailInfo.rawReqInfo.body = Buffer.concat(body);
            ctx.recorder.updateRawReqBody(detailInfo);
            if (detailInfo.waitReqData) {
                detailInfo.reqInfo.body = detailInfo.rawReqInfo.body;
            }
            resolve();
        });
    });
}

function sendFinalResponse(detailInfo, rawRes, ctx) {
    const { res, resInfo, dealRequest, waitResData } = detailInfo;

    if (!resInfo) {
        throw new Error('获取响应信息失败');
    } else if (!resInfo.statusCode) {
        throw new Error('获取响应状态码失败')
    } else if (!resInfo.headers) {
        throw new Error('获取响应头失败');
    }

    let useRawRes = false;
    rawRes.on('close', () => {  
        ctx.recorder.updateUserResEnd(detailInfo, useRawRes);
    });

    if (!dealRequest) {
        useRawRes = true;
        rawRes.writeHead(resInfo.statusCode, resInfo.headers);
        res.pipe(rawRes);
        ctx.recorder.updateUserRes(detailInfo, true);
        return;
    }

    useRawRes = (!waitResData && resInfo.body === undefined);
    const headers = resInfo.headers;
    if (!useRawRes) {
        const transferEncoding = headers['transfer-encoding'] || headers['Transfer-Encoding'] || '';
        const contentLength = headers['content-length'] || headers['Content-Length'];
        const connection = headers.Connection || headers.connection;
        if (contentLength) {
            delete headers['content-length'];
            delete headers['Content-Length'];
        }

        if (connection) {
            headers['x-anyproxy-origin-connection'] = connection;
            delete headers.connection;
            delete headers.Connection;
        }

        if (!ctx._throttle && transferEncoding !== 'chunked') {
            headers['Content-Length'] = util.getByteSize(resInfo.body);
        }
    }
    rawRes.writeHead(resInfo.statusCode, headers);
    if (ctx._throttle) {
        if (useRawRes) {
            res.pipe(ctx._throttle.throttle()).pipe(rawRes);
        } else {
            const _stream = new Stream();
            _stream.pipe(ctx._throttle.throttle()).pipe(rawRes);
            _stream.emit('data', resInfo.body);
            _stream.emit('end');
        }
    } else {
        if (useRawRes) {
            res.pipe(rawRes);
        } else {
            rawRes.end(resInfo.body);
        }
    }
    ctx.recorder.updateUserRes(detailInfo);
}

async function _connectListener(req, clientSocket, head) {
    //ws请求 wss请求 https请求, http请求直接响应 httpServerPort
    const [host, port] = req.url.split(':');
    const proxyRule = this.proxyRule;
    const connectDetail = { host, port, protocol: 'https' };

    logUtil.printLog(chalk.green(`收到HTTPS CONNECT请求: ${req.url}`));
    //本地wss对接客户端ws
    let isWsRequest = false;
    try {
        let shouldIntercept = true;
        if (await proxyRule.isDealConnect(connectDetail) === false) {
            shouldIntercept = false
        }
        logUtil.printLog(shouldIntercept ? '将转发到本地HTTP服务器' : '将绕过中间人代理');
        await new Promise((resolve) => {
            clientSocket.write(`HTTP/${req.httpVersion} 200 OK\r\n\r\n`, 'UTF-8', resolve);
        });
        const requestStream = new ReadableStream();
        await new Promise((resolve, reject) => {
            let firstRead = false;
            clientSocket.on('data', (chunk) => {
                requestStream.push(chunk);
                if (!firstRead) {
                    firstRead = true;
                    try {
                        const chunkString = chunk.toString();
                        if (chunkString.indexOf('GET ') === 0) {
                            //没有加密，GET  表示ws请求
                            isWsRequest = true;
                            shouldIntercept = false;
                        }
                    } catch (e) {
                        reject(e);
                    }
                    resolve();
                }
            });
            clientSocket.on('end', () => {
                requestStream.push(null);
            });
            clientSocket.on('error', (error) => {
                logUtil.printLog(util.collectErrorLog(error), logUtil.T_ERR);
                proxyRule.onConnectError(error, connectDetail);
                reject(error);
            });

        })

        //ws直接转发，不支持转发到本地的ws服务上
        let serverInfo = isWsRequest ? {
            host: '127.0.0.1',
            port: this.httpServerPort
        } : { host: host, port: port || 80 };

        if (shouldIntercept) {
            let port = await this.httpsServerMgr.getSharedHttpsServer(host);
            serverInfo = { host: '127.0.0.1', port };
        }
        const serverSocket = net.connect(serverInfo.port, serverInfo.host, () => {
            if (this._throttle && shouldIntercept) {
                requestStream.pipe(serverSocket);
                serverSocket.pipe(this._throttle.throttle()).pipe(clientSocket);
            } else {
                requestStream.pipe(serverSocket);
                serverSocket.pipe(clientSocket);
            }
        });

        serverSocket.on('error', (e) => {
            serverSocket.destroy();
            clientSocket.destroy();
        });

        this.saveConnectSocket(serverSocket);
        this.saveConnectSocket(clientSocket);

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
        } catch (e) {
        }
    }

}

const MIME_MAP = {
    "aiff": "audio/x-aiff",
    "arj": "application/x-arj-compressed",
    "asf": "video/x-ms-asf",
    "asx": "video/x-ms-asx",
    "au": "audio/ulaw",
    "avi": "video/x-msvideo",
    "bcpio": "application/x-bcpio",
    "ccad": "application/clariscad",
    "cod": "application/vnd.rim.cod",
    "com": "application/x-msdos-program",
    "cpio": "application/x-cpio",
    "cpt": "application/mac-compactpro",
    "csh": "application/x-csh",
    "css": "text/css",
    "deb": "application/x-debian-package",
    "dl": "video/dl",
    "doc": "application/msword",
    "drw": "application/drafting",
    "dvi": "application/x-dvi",
    "dwg": "application/acad",
    "dxf": "application/dxf",
    "dxr": "application/x-director",
    "etx": "text/x-setext",
    "ez": "application/andrew-inset",
    "fli": "video/x-fli",
    "flv": "video/x-flv",
    "gif": "image/gif",
    "gl": "video/gl",
    "gtar": "application/x-gtar",
    "gz": "application/x-gzip",
    "hdf": "application/x-hdf",
    "hqx": "application/mac-binhex40",
    "html": "text/html",
    "ice": "x-conference/x-cooltalk",
    "ico": "image/x-icon",
    "ief": "image/ief",
    "igs": "model/iges",
    "ips": "application/x-ipscript",
    "ipx": "application/x-ipix",
    "jad": "text/vnd.sun.j2me.app-descriptor",
    "jar": "application/java-archive",
    "jpeg": "image/jpeg",
    "jpg": "image/jpeg",
    "js": "text/javascript",
    "json": "application/json",
    "latex": "application/x-latex",
    "lsp": "application/x-lisp",
    "lzh": "application/octet-stream",
    "m": "text/plain",
    "m3u": "audio/x-mpegurl",
    "man": "application/x-troff-man",
    "me": "application/x-troff-me",
    "midi": "audio/midi",
    "mif": "application/x-mif",
    "mime": "www/mime",
    "movie": "video/x-sgi-movie",
    "mp4": "video/mp4",
    "mpg": "video/mpeg",
    "mpga": "audio/mpeg",
    "ms": "application/x-troff-ms",
    "nc": "application/x-netcdf",
    "oda": "application/oda",
    "ogm": "application/ogg",
    "pbm": "image/x-portable-bitmap",
    "pdf": "application/pdf",
    "pgm": "image/x-portable-graymap",
    "pgn": "application/x-chess-pgn",
    "pgp": "application/pgp",
    "pm": "application/x-perl",
    "png": "image/png",
    "pnm": "image/x-portable-anymap",
    "ppm": "image/x-portable-pixmap",
    "ppz": "application/vnd.ms-powerpoint",
    "pre": "application/x-freelance",
    "prt": "application/pro_eng",
    "ps": "application/postscript",
    "qt": "video/quicktime",
    "ra": "audio/x-realaudio",
    "rar": "application/x-rar-compressed",
    "ras": "image/x-cmu-raster",
    "rgb": "image/x-rgb",
    "rm": "audio/x-pn-realaudio",
    "rpm": "audio/x-pn-realaudio-plugin",
    "rtf": "text/rtf",
    "rtx": "text/richtext",
    "scm": "application/x-lotusscreencam",
    "set": "application/set",
    "sgml": "text/sgml",
    "sh": "application/x-sh",
    "shar": "application/x-shar",
    "silo": "model/mesh",
    "sit": "application/x-stuffit",
    "skt": "application/x-koan",
    "smil": "application/smil",
    "snd": "audio/basic",
    "sol": "application/solids",
    "spl": "application/x-futuresplash",
    "src": "application/x-wais-source",
    "stl": "application/SLA",
    "stp": "application/STEP",
    "sv4cpio": "application/x-sv4cpio",
    "sv4crc": "application/x-sv4crc",
    "svg": "image/svg+xml",
    "swf": "application/x-shockwave-flash",
    "tar": "application/x-tar",
    "tcl": "application/x-tcl",
    "tex": "application/x-tex",
    "texinfo": "application/x-texinfo",
    "tgz": "application/x-tar-gz",
    "tiff": "image/tiff",
    "tr": "application/x-troff",
    "tsi": "audio/TSP-audio",
    "tsp": "application/dsptype",
    "tsv": "text/tab-separated-values",
    "txt": "text/plain",
    "unv": "application/i-deas",
    "ustar": "application/x-ustar",
    "vcd": "application/x-cdlink",
    "vda": "application/vda",
    "vivo": "video/vnd.vivo",
    "vrm": "x-world/x-vrml",
    "wav": "audio/x-wav",
    "wax": "audio/x-ms-wax",
    "wma": "audio/x-ms-wma",
    "wmv": "video/x-ms-wmv",
    "wmx": "video/x-ms-wmx",
    "wrl": "model/vrml",
    "wvx": "video/x-ms-wvx",
    "xbm": "image/x-xbitmap",
    "xlw": "application/vnd.ms-excel",
    "xml": "text/xml",
    "xpm": "image/x-xpixmap",
    "xwd": "image/x-xwindowdump",
    "xyz": "chemical/x-pdb",
    "zip": "application/zip"
};

class RequestHandler {
    constructor(config, proxyServer) {
        this.dangerouslyIgnoreUnauthorized = !!config.dangerouslyIgnoreUnauthorized;
        this.httpServerPort = config.httpServerPort || '';
        this.proxyServer = proxyServer;
        this._throttle = proxyServer._throttle;
        // 获取用户请求处理器
        this.requestListener = _requestListener.bind(this);

        // 获取连接请求处理器
        this.connectListener = _connectListener.bind(this);

        // 获取WebSocket处理器
        this.connectionListener = _connectionListener.bind(this);

        // 创建HTTPS服务器管理器
        this.httpsServerMgr = new HttpsServerMgr({
            requestListener: this.requestListener,
            connectionListener: this.connectionListener, // WebSocket处理器
        });

        this.socketPool = {};
        this.socketIndex = 0;
    }

    saveConnectSocket(socket) {
        const key = `socketIndex_${this.socketIndex++}`;
        this.socketPool[key] = socket;
        socket.on('close', () => {
            delete this.socketPool[key];
        });
    }

    close() {
        for (let key in this.socketPool) {
            this.socketPool[key].destroy();
        }
        this.httpsServerMgr.close();
    }



    systemRequest(urlPattern, userRes) {
        if (urlPattern.pathname === '/__anyproxy/api/reload_rule') {
            userRes.writeHead(200, {});
            userRes.end('refresh user_rule');
            this.proxyServer.reloadProxyRule();
            return true;
        }

        if (urlPattern.pathname === '/__anyproxy/api/close') {
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

        if (urlPattern.pathname === '/__anyproxy/api/logs') {
            this.recorder.getLogs().then((logs) => {
                userRes.writeHead(200, { 'Content-Type': "application/json" });
                userRes.end(JSON.stringify(logs));
            })
            return true;
        }

        if (urlPattern.pathname === '/__anyproxy/api/log') {
            let id = urlPattern.searchParams.get('id');
            if (id) {
                this.recorder.getLog(id).then((log) => {
                    userRes.writeHead(200, { 'Content-Type': "application/json" });
                    userRes.end(JSON.stringify(log));
                })
            }
            return true;
        }

        if (urlPattern.pathname.indexOf('/__anyproxy/web/') === 0) {
            const filePath = path.join(__dirname, '../web/dist/' + urlPattern.pathname.replace('/__anyproxy/web/', ''));
            fs.access(filePath, fs.constants.R_OK, (err) => {
                if (err) {
                    userRes.writeHead(404, {
                        'Content-Type': 'text/plain'
                    });
                    userRes.end('__anyproxy web');
                } else {
                    var ext = path.extname(filePath);
                    ext = ext ? ext.slice(1) : 'html';
                    var contentType = MIME_MAP[ext] || "text/plain";
                    userRes.writeHead(200, { 'Content-Type': contentType });
                    fs.createReadStream(filePath).pipe(userRes);
                }
            });

            return true;
        }

        return false;
    }


    get proxyRule() {
        return this.proxyServer.proxyRule;
    }

    get recorder() {
        return this.proxyServer.recorder;
    }

}

module.exports = RequestHandler;
