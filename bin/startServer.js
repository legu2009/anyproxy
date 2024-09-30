/**
* 启动AnyProxy服务器
*/

const ruleLoader = require('../src/ruleLoader');
const logUtil = require('../src/log');
const AnyProxy = require('../proxy');

module.exports = async function startServer(program) {
    // 加载规则模块
    if (program.rule) {
        await ruleLoader.requireModule(program.rule);
    }
    let proxyServer = new AnyProxy.ProxyServer({
        type: 'http',
        port: program.port || 8001,
        throttle: program.throttle,
        rule: ruleModule,
        dangerouslyIgnoreUnauthorized: !!program.ignoreUnauthorizedSsl,
        silent: program.silent
    });

    proxyServer.start();

    process.on('exit', (code) => {
        if (code > 0) {
            logUtil.printLog('AnyProxy即将退出，退出代码: ' + code, logUtil.T_ERR);
        }
        process.exit();
    });

    process.on('SIGINT', () => {
        try {
            proxyServer && proxyServer.close();
        } catch (e) {
            console.error(e);
        }
        process.exit();
    });

    process.on('uncaughtException', (err) => {
        let errorTipText = '捕获到未处理的异常，您的规则文件中是否有错误？\n';
        try {
            if (err && err.stack) {
                errorTipText += err.stack;
            } else {
                errorTipText += err;
            }
        } catch (e) { }
        logUtil.printLog(errorTipText, logUtil.T_ERR);
        try {
            proxyServer && proxyServer.close();
        } catch (e) { }
        process.exit();
    });
}
