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
const MemoizeTaskMgr = require('./memoizeTaskMgr');
const { createWsServer } = require('./wsServer');


function createHttpsSNIServer(port, handler) {
    const createSecureContext = tls.createSecureContext || crypto.createSecureContext;
    async function SNIPrepareCert(serverName, SNICallback) {
        let ctx;
        try {
            const { key, cert } = await certMgr.getCertificatePromise(serverName);
            ctx = createSecureContext({ key, cert });
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
    const { key, cert } = await certMgr.getCertificatePromise(ip);
    return https.createServer({
        secureOptions: constants.SSL_OP_NO_SSLv3 || constants.SSL_OP_NO_TLSv1,
        key,
        cert,
    }, handler).listen(port);
}

class HttpsServerManager {
    constructor(config) {
        this.memoizeTaskMgr = new MemoizeTaskMgr();
        this.requestListener = config.requestListener;
        this.connectionListener = config.connectionListener;
        this.activeServers = [];
    }

    getSharedHttpsServer(hostname) {
        const self = this;
        const ifIPHost = util.isIp(hostname);
        async function createServer(callback) {
            try {
                let port = await util.getFreePort();
                let httpsServer
                if (ifIPHost) {
                    httpsServer = await createHttpsIPServer(hostname, port, self.requestListener);
                } else {
                    httpsServer = await createHttpsSNIServer(port, self.requestListener);
                }
                self.activeServers.push(httpsServer);
                createWsServer({
                    server: httpsServer,
                    connectionListener: self.connectionListener
                });
                httpsServer.on('upgrade', () => {
                    logUtil.debug('将让WebSocket服务器处理升级事件');
                });
                callback(null, port);
            } catch (error) {
                callback(e);
            }
        }

        // 相同主机使用相同服务器
        return new Promise((resolve, reject) => {
            self.memoizeTaskMgr.addTask(ifIPHost ? hostname : '127.0.0.1', createServer, (error, port) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(port);
                }
            });
        });
    }

    close() {
        this.activeServers.forEach((httpsServer) => {
            httpsServer.close();
        });
    }
}

module.exports = HttpsServerManager;
