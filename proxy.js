'use strict';

const http = require('http');
const https = require('https');
const chalk = require('chalk');
const events = require('events');
const path = require('path');
const certMgr = require('./src/certMgr');
const logUtil = require('./src/log');
const util = require('./src/util');
const Recorder = require('./src/recorder');
const RequestHandler = require('./src/requestHandler');
const { ThrottleGroup } = require('stream-throttle');
const default_rule = require('./src/rule_default');
const { createWsServer } = require('./src/wsServer');

const T_TYPE_HTTP = 'http';
const T_TYPE_HTTPS = 'https';
const DEFAULT_TYPE = T_TYPE_HTTP;

const PROXY_STATUS = {
    INIT: 'INIT',
    READY: 'READY',
    CLOSED: 'CLOSED'
};



/**
 * 代理核心类
 */
class ProxyCore extends events.EventEmitter {

    constructor(config = {}) {
        super();
        this.socketPool = {};
        this.socketIndex = 1;
        this.connectionListener = this.connectionListener.bind(this);
        this.initConfig(config);
        this.initComponents(config);
    }

    /**
     * 初始化配置
     */
    initConfig(config) {
        this.status = PROXY_STATUS.INIT;
        this.proxyPort = config.port;
        this.proxyType = /https/i.test(config.type || DEFAULT_TYPE) ? T_TYPE_HTTPS : T_TYPE_HTTP;
        this.proxyHostName = config.hostname || 'localhost';
        this.validateConfig(config);
    }

    /**
     * 验证配置
     */
    validateConfig(config) {
        if (!certMgr.ifRootCAFileExists()) {
            logUtil.printLog('您可以运行 `anyproxy-ca` 生成一个根CA，然后重新运行此命令');
            throw new Error('未找到根CA。请先运行 `anyproxy-ca` 生成一个。');
        }
        if (this.proxyType === T_TYPE_HTTPS && !config.hostname) {
            throw new Error('https代理需要指定hostname');
        }
        if (!this.proxyPort) {
            throw new Error('需要指定代理端口');
        }
    }

    /**
     * 初始化组件
     */
    initComponents(config) {
        if (config.silent) {
            logUtil.setPrintStatus(false);
        }
        this.recorder = config.recorder;
        this.initProxyRule(config);
        this.initThrottle(config);
        this.requestHandler = new RequestHandler({
            httpServerPort: config.port,
            dangerouslyIgnoreUnauthorized: !!config.dangerouslyIgnoreUnauthorized
        }, this);
    }

    /**
     * 初始化代理规则
     */
    initProxyRule(config) {
        let rule = {};
        if (config.ruleFilePath) {
            const ruleFilePath = path.resolve(process.cwd(), config.ruleFilePath);
            config.ruleFilePath = ruleFilePath;
            rule = util.freshRequire(ruleFilePath);
        } else {
            rule = config.rule || {};
        }
        this.proxyRule = util.merge(default_rule, rule);
    }

    reloadProxyRule() {
        if (this.config.ruleFilePath) {
            this.proxyRule = util.merge(default_rule, util.freshRequire(this.config.ruleFilePath));
        }
    }

    /**
     * 初始化限速
     */
    initThrottle(config) {
        if (config.throttle) {
            logUtil.printLog(`限速：${config.throttle}kb/s`);
            const rate = parseInt(config.throttle, 10);
            if (rate < 1) {
                throw new Error('无效的限速值，应为正整数');
            }
            this._throttle = new ThrottleGroup({ rate: 1024 * rate });
        }
    }

    /**
    * 管理所有创建的socket
    * 对于每个新socket，我们将其放入一个map中；
    * 如果socket自行关闭，我们从map中移除它
    * 当调用`close`方法时，我们会在服务器关闭前关闭这些socket
    *
    * @param {Socket} 正在创建的http socket
    * @returns undefined
    * @memberOf ProxyCore
    */
    connectionListener(socket) {
        const key = `socketIndex_${this.socketIndex++}`;
        this.socketPool[key] = socket;
        socket.on('close', () => {
            delete this.socketPool[key];
        });
    }
    /**
     * 启动代理服务器
     * @returns ProxyCore
     * @memberOf ProxyCore
     */
    async start() {
        if (this.status !== PROXY_STATUS.INIT) {
            throw new Error('服务器状态不是PROXY_STATUS_INIT，无法运行start()');
        }

        this.socketPool = {};
        try {
            let httpProxyServer;
            let requestHandler = this.requestHandler;
            if (this.proxyType === T_TYPE_HTTPS) {
                const { key, cert } = await certMgr.getCertificatePromise(this.proxyHostName);
                httpProxyServer = https.createServer({ key, cert }, requestHandler.requestListener);
            } else {
                httpProxyServer = http.createServer(requestHandler.requestListener);
            }
            this.httpProxyServer = httpProxyServer;
            createWsServer({
                server: httpProxyServer,
                connectionListener: requestHandler.connectionListener
            });
            httpProxyServer.on('connect', requestHandler.connectListener);

            // 记住所有socket，以便在调用'close'方法时销毁它们
            httpProxyServer.on('connection', this.connectionListener);
            httpProxyServer.listen(this.proxyPort);
        } catch (error) {
            logUtil.printLog(chalk.red('启动代理服务器时出错 :('), logUtil.T_ERR);
            logUtil.printLog(error, logUtil.T_ERR);
            this.emit('error', { error });
            return;
        }

        const tipText = (this.proxyType === T_TYPE_HTTP ? 'Http' : 'Https') + ' 代理已启动，端口：' + this.proxyPort;
        logUtil.printLog(chalk.green(tipText));
        logUtil.printLog(chalk.green(`当前生效的规则是：${await this.proxyRule.summary()}`));

        this.status = PROXY_STATUS.READY;
        this.emit('ready');
    }

    async close() {
        if (!this.httpProxyServer) {
            process.exit();
            return;
        }
        let { requestHandler } = this;
        requestHandler.close();
        for (let key in this.socketPool) {
            this.socketPool[key].destroy();
        }

        await new Promise((resolve, reject) => {
            this.httpProxyServer.close((error) => {
                if (error) {
                    reject(error);
                    logUtil.printLog(`代理服务器关闭失败：${error.message}`, logUtil.T_ERR);
                    return;
                }
                this.httpProxyServer = null;
                this.status = PROXY_STATUS.CLOSED;
                logUtil.printLog(`代理服务器已关闭，地址：${this.proxyHostName}:${this.proxyPort}`);
                resolve();
            });
        })
        process.exit();
    }
}

/**
 * 启动代理服务器以及recorder和网页界面
 */
class ProxyServer extends ProxyCore {
    /**
     *
     * @param {object} config - 配置
     * @param {object} [config.webInterface] - 网页界面配置
     * @param {boolean} [config.webInterface.enable=false] - 是否启用网页界面
     * @param {number} [config.webInterface.webPort=8002] - 网页界面的http端口
     */
    constructor(config) {
        // 准备一个recorder
        super(config);
        const recorder = new Recorder();
        this.recorder = recorder;
    }

    async start() {
        await this.recorder.start();
        super.start();
    }

}

module.exports.ProxyCore = ProxyCore;
module.exports.ProxyServer = ProxyServer;
module.exports.utils = {
    systemProxyMgr: require('./src/systemProxyMgr'),
    certMgr,
};
