/**
* 检查根CA是否存在并已安装
* 如果需要，将提示生成
*/

const AnyProxy = require('../proxy');
const logUtil = require('../src/log');

const certMgr = AnyProxy.utils.certMgr;

module.exports = async () => {
    if (!certMgr.isRootCAFileExists()) {
        logUtil.warn('缺少根CA，正在生成');
        await certMgr.generateRootCA();
        await certMgr.trustRootCA();
    } else {
        const isCATrusted = await certMgr.ifRootCATrustedPromise();
        if (!isCATrusted) {
            logUtil.warn('根CA尚未安装');
            await certMgr.trustRootCA();
        }
    }
};
