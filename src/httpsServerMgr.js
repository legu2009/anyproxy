'use strict'

// 管理https服务器
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const chalk = require('chalk');
const constants = require('constants');

const certMgr = require('./certMgr');
const logUtil = require('./log');
const util = require('./util');
const CachedTaskManager = require('./cachedTaskManager');
const { createWsServer } = require('./wsServerMgr');


function createHttpsSNIServer(port, handler) {
    const createSecureContext = tls.createSecureContext || crypto.createSecureContext;
    async function SNIPrepareCert(serverName, SNICallback) {
        let ctx;
        try {
            const { keyContent, crtContent } = await certMgr.getCertificatePromise(serverName);
            ctx = createSecureContext({
                key: keyContent,
                cert: crtContent
            });
            const tipText = `为${serverName}建立代理服务器`;
            logUtil.printLog(chalk.yellow(chalk.bold('[内部https]')) + chalk.yellow(tipText));
            SNICallback(null, ctx);
        } catch (err) {
            logUtil.printLog(`为SNI准备证书时发生错误 - ${err}`, logUtil.T_ERR);
            logUtil.printLog(`为SNI准备证书时发生错误 - ${err.stack}`, logUtil.T_ERR);
            SNICallback(err);
        }
    }

    return https.createServer({
        secureOptions: constants.SSL_OP_NO_SSLv3 || constants.SSL_OP_NO_TLSv1,
        SNICallback: SNIPrepareCert,
    }, handler).listen(port);
}

async function createHttpsIPServer(ip, port, handler) {
    const { keyContent, crtContent } = await certMgr.getCertificatePromise(ip);
    return https.createServer({
        secureOptions: constants.SSL_OP_NO_SSLv3 || constants.SSL_OP_NO_TLSv1,
        key: keyContent,
        cert: crtContent,
    }, handler).listen(port);
}

class HttpsServerManager {
    constructor(config) {
        this.httpsAsyncTask = new CachedTaskManager();
        this.requestHandler = config.requestHandler;
        this.wsHandler = config.wsHandler;
        this.activeServers = [];
    }

    getSharedHttpsServer(hostname) {
        const self = this;
        const ifIPHost = hostname && util.isIp(hostname);
        const serverHost = '127.0.0.1';

        async function prepareServer(callback) {
            try {
                let port = await util.getFreePort();
                let httpsServer
                if (ifIPHost) {
                    httpsServer = await createHttpsIPServer(hostname, port, self.requestHandler);
                } else {
                    httpsServer = await createHttpsSNIServer(port, self.requestHandler);
                }
                self.activeServers.push(httpsServer);
                createWsServer({
                    server: httpsServer,
                    connHandler: self.wsHandler
                });

                httpsServer.on('upgrade', (req, clientSocket, head) => {
                    logUtil.debug('将让WebSocket服务器处理升级事件');
                });
                callback(null, {
                    host: serverHost,
                    port,
                });
            } catch (error) {
                callback(e);
            }
        }

        // 相同主机使用相同服务器
        return new Promise((resolve, reject) => {
            self.httpsAsyncTask.addTask(ifIPHost ? hostname : serverHost, prepareServer, (error, serverInfo) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(serverInfo);
                }
            });
        });
    }

    close() {
        this.activeServers.forEach((server) => {
            server.close();
        });
    }
}

module.exports = HttpsServerManager;
