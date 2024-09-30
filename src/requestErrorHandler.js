'use strict';

/*
* 在此处理所有请求错误
*
*/
const pug = require('pug');
const path = require('path');

const error502PugFn = pug.compileFile(path.join(__dirname, '../resource/502.pug'));
const certPugFn = pug.compileFile(path.join(__dirname, '../resource/cert_error.pug'));

/**
* 获取证书问题的错误内容
*/
function getCertErrorContent(error, fullUrl) {
    let content;
    const title = '连接不安全。';
    let explain = '网站证书存在问题。';
    switch (error.code) {
        case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY': {
            explain = '您正在访问的网站的证书不是由已知机构颁发的，'
                + '这通常发生在证书是自签名的情况下。</br>'
                + '如果您了解并信任该网站，可以使用 <strong>-ignore-unauthorized-ssl</strong> 选项运行 AnyProxy 以继续。'

            break;
        }
        default: {
            explain = ''
            break;
        }
    }

    try {
        content = certPugFn({
            title: title,
            explain: explain,
            code: error.code
        });
    } catch (parseErro) {
        content = error.stack;
    }

    return content;
}

/*
* 获取默认错误内容
*/
function getDefaultErrorCotent(error, fullUrl) {
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

    return content;
}

/*
* 获取每个错误的映射错误内容
*/
module.exports.getErrorContent = (error, fullUrl) => {
    let content = '';
    error = error || {};
    switch (error.code) {
        case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY': {
            content = getCertErrorContent(error, fullUrl);
            break;
        }
        default: {
            content = getDefaultErrorCotent(error, fullUrl);
            break;
        }
    }

    return content;
}
