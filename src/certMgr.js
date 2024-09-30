'use strict'

const EasyCert = require('node-easy-cert');
const os = require('os');
const util = require('./util');
const logUtil = require('./log');
const { promisify } = require('util');
const inquirer = require('inquirer').default;

const options = {
    rootDirPath: util.getAnyProxyPath('certificates'),
    inMemory: false,
    defaultCertAttrs: [
        { name: 'countryName', value: 'CN' },
        { name: 'organizationName', value: 'AnyProxy' },
        { shortName: 'ST', value: 'SH' },
        { shortName: 'OU', value: 'AnyProxy SSL Proxy' }
    ]
};

const easyCert = new EasyCert(options);
const crtMgr = util.merge({}, easyCert);

crtMgr.ifRootCAFileExists = easyCert.isRootCAFileExists;

crtMgr.generateRootCA = () => {
    return new Promise((resolve, reject) => {
        const rootOptions = {
            commonName: 'AnyProxy',
            overwrite: false
        };
        easyCert.generateRootCA(rootOptions, (error, keyPath, crtPath) => {
            if (error) {
                reject(error);
            } else {
                resolve({ keyPath, crtPath });
            }
        });
    })
};

crtMgr.getCAStatus = async () => {
    const result = {
        exist: false,
    };
    const ifExist = easyCert.isRootCAFileExists();
    if (!ifExist) {
        return result;
    } else {
        result.exist = true;
        if (!/^win/.test(process.platform)) {
            result.trusted = await crtMgr.ifRootCATrustedPromise();
        }
        return result;
    }
}

/**
 * 通过命令信任根证书
 */
crtMgr.trustRootCA = async () => {
    const platform = os.platform();
    const rootCAPath = crtMgr.getRootCAFilePath();
    console.log(platform);

    if (platform === 'darwin') {
        const answers = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'trustCA',
                message: '根证书尚未被信任，是否现在将其安装到信任存储？',
                default: true
            }
        ]);
        if (answers.trustCA) {
            logUtil.info('即将信任根证书，这可能需要您输入密码');
            const result = util.execScriptSync(`sudo security add-trusted-cert -d -k /Library/Keychains/System.keychain ${rootCAPath}`);
            if (result.status === 0) {
                logUtil.info('根证书已安装，您现在可以拦截https请求了');
            } else {
                console.error(result);
                logUtil.info('无法信任根证书，请手动信任');
            }
        } else {
            logUtil.info('请手动信任根证书以使https拦截功能正常工作');
        }
    }

    if (/^win/.test(process.platform)) {
        logUtil.info('您可以手动安装根证书。');
    }
    logUtil.info('根证书文件路径为: ' + crtMgr.getRootCAFilePath());
}

crtMgr.getCertificatePromise = (host) => {
    return new Promise((resolve, reject) => {
        crtMgr.getCertificate(host, (err, keyContent, crtContent) => {
            if (err) {
                reject(err);
            } else {
                resolve({ keyContent, crtContent })
            }
        });
    })
};


crtMgr.ifRootCATrustedPromise = promisify(easyCert.ifRootCATrusted);




module.exports = crtMgr;
