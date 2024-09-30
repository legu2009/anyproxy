'use strict';

const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const os = require('os');
const Buffer = require('buffer').Buffer;

const util = {

    merge(baseObj, extendObj) {
        return { ...baseObj, ...extendObj };
    },

    getUserHome() {
        return process.env.HOME || process.env.USERPROFILE;
    },

    getAnyProxyHome() {
        const home = path.join(this.getUserHome(), '/.anyproxy/');
        if (!fs.existsSync(home)) {
            fs.mkdirSync(home);
        }
        return home;
    },

    getAnyProxyPath(pathName) {
        const home = this.getAnyProxyHome();
        const targetPath = path.join(home, pathName);
        if (!fs.existsSync(targetPath)) {
            fs.mkdirSync(targetPath);
        }
        return targetPath;
    },

    getAnyProxyTmpPath() {
        const targetPath = path.join(os.tmpdir(), 'anyproxy', 'cache');
        if (!fs.existsSync(targetPath)) {
            fs.mkdirSync(targetPath, { recursive: true });
        }
        return targetPath;
    },

    freshRequire(modulePath) {
        delete require.cache[require.resolve(modulePath)];
        return require(modulePath);
    },


    getHeaderFromRawHeaders(rawHeaders) {
        const headerObj = {};
        const _handleSetCookieHeader = (key, value) => {
            if (Array.isArray(headerObj[key])) {
                headerObj[key].push(value);
            } else {
                headerObj[key] = [headerObj[key], value];
            }
        };

        if (rawHeaders) {
            for (let i = 0; i < rawHeaders.length; i += 2) {
                const key = rawHeaders[i];
                let value = rawHeaders[i + 1];

                if (typeof value === 'string') {
                    value = value.replace(/\0+$/g, ''); // 去除 \u0000的null字符串
                }

                if (!headerObj[key]) {
                    headerObj[key] = value;
                } else {
                    if (key.toLowerCase() === 'set-cookie') {
                        _handleSetCookieHeader(key, value);
                    } else {
                        headerObj[key] = headerObj[key] + ',' + value;
                    }
                }
            }
        }
        return headerObj;
    },


    deleteFolderContentsRecursive(dirPath, ifClearFolderItself) {
        if (!dirPath.trim() || dirPath === '/') {
            throw new Error('无法删除此目录');
        }

        if (fs.existsSync(dirPath)) {
            fs.readdirSync(dirPath).forEach((file) => {
                const curPath = path.join(dirPath, file);
                if (fs.lstatSync(curPath).isDirectory()) {
                    this.deleteFolderContentsRecursive(curPath, true);
                } else {
                    fs.unlinkSync(curPath);
                }
            });

            if (ifClearFolderItself) {
                try {
                    const start = Date.now();
                    while (true) {
                        try {
                            fs.rmdirSync(dirPath);
                            break;
                        } catch (er) {
                            if (process.platform === 'win32' && (er.code === 'ENOTEMPTY' || er.code === 'EBUSY' || er.code === 'EPERM')) {
                                if (Date.now() - start > 1000) throw er;
                            } else if (er.code === 'ENOENT') {
                                break;
                            } else {
                                throw er;
                            }
                        }
                    }
                } catch (e) {
                    throw new Error('无法删除目录 (错误代码 ' + e.code + '): ' + dirPath);
                }
            }
        }
    },

    getFreePort() {
        return new Promise((resolve, reject) => {
            const server = require('net').createServer();
            server.unref();
            server.on('error', reject);
            server.listen(0, () => {
                const port = server.address().port;
                server.close(() => {
                    resolve(port);
                });
            });
        });
    },

    collectErrorLog(error) {
        if (error && error.code && error.toString()) {
            return error.toString();
        } else {
            let result = [error, error.stack].join('\n');
            try {
                const errorString = error.toString();
                if (errorString.indexOf('You may only yield a function') >= 0) {
                    result = '函数不可yield。您是否忘记在规则文件中提供生成器或promise？\n常见问题解答 http://anyproxy.io/4.x/#faq';
                }
            } catch (e) { }
            return result;
        }
    },


    getByteSize(content) {
        return Buffer.byteLength(content);
    },

    isIp(domain) {
        if (!domain) {
            return false;
        }
        const ipReg = /^\d+?\.\d+?\.\d+?\.\d+?$/;
        return ipReg.test(domain);
    },

    execScriptSync(cmd) {
        let stdout;
        let status = 0;
        try {
            stdout = child_process.execSync(cmd);
        } catch (err) {
            stdout = err.stdout;
            status = err.status;
        }

        return {
            stdout: stdout.toString(),
            status
        };
    },
};

Object.assign(module.exports, util);