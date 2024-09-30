'use strict'

// 开始记录并在需要时共享列表
const Datastore = require('nedb');
const path = require('path');
const fs = require('fs');
const logUtil = require('./log');
const events = require('events');
const iconv = require('iconv-lite');
const fastJson = require('fast-json-stringify');
const proxyUtil = require('./util');

const wsMessageStingify = fastJson({
    title: 'ws消息字符串化',
    type: 'object',
    properties: {
        time: {
            type: 'integer'
        },
        message: {
            type: 'string'
        },
        isToServer: {
            type: 'boolean'
        }
    }
});

const BODY_FILE_PRFIX = 'res_body_';
const WS_MESSAGE_FILE_PRFIX = 'ws_message_';
const CACHE_DIR_PREFIX = 'cache_r';

function getCacheDir() {
    const rand = Math.floor(Math.random() * 1000000);
    const cachePath = path.join(proxyUtil.getAnyProxyTmpPath(), `./${CACHE_DIR_PREFIX}${rand}`);
    fs.mkdirSync(cachePath);
    return cachePath;
}

function normalizeInfo(id, info) {
    const singleRecord = {
        _id: id,
        id: id,
        url: info.url,
        host: info.host,
        path: info.path,
        method: info.method,
        //reqHeader: info.req.headers,
        startTime: info.startTime,
        reqBody: info.reqBody || '',
        protocol: info.protocol || '',
        statusCode: info.endTime ? info.statusCode : '',
        endTime: info.endTime || '',
        resHeader: info.endTime ? info.resHeader : '',
        length: info.endTime ? info.length : '',
        mime: info.endTime ? (info.resHeader['content-type'] || info.resHeader['Content-Type'] || '').split(';')[0] : '',
        duration: info.endTime ? info.endTime - info.startTime : ''
    };

    return singleRecord;
}

class Recorder extends events.EventEmitter {
    constructor(config) {
        super(config);
        this.globalId = 1;
        this.cachePath = getCacheDir();
        this.db = new Datastore();
        this.recordBodyMap = [];
    }

    setDbAutoCompact() {
        this.db.persistence.setAutocompactionInterval(5001);
    }

    stopDbAutoCompact() {
        try {
            this.db.persistence.stopAutocompaction();
        } catch (e) {
            logUtil.printLog(e, logUtil.T_ERR);
        }
    }

    emitUpdate(id, info) {
        if (info) {
            this.emit('update', info);
        } else {
            this.getSingleRecord(id, (err, doc) => {
                if (!err && doc && doc[0]) {
                    this.emit('update', doc[0]);
                }
            });
        }
    }

    emitUpdateLatestWsMessage(id, message) {
        this.emit('updateLatestWsMsg', message);
    }

    updateRecord(id, info) {
        if (id < 0) return;
        const finalInfo = normalizeInfo(id, info);
        this.db.update({ _id: id }, finalInfo);
        this.updateRecordBody(id, info);
        this.emitUpdate(id, finalInfo);
    }

    updateRecordWsMessage(id, message) {
        if (id < 0) return;
        try {
            this.getCacheFile(WS_MESSAGE_FILE_PRFIX + id, (err, recordWsMessageFile) => {
                if (err) return;
                fs.appendFile(recordWsMessageFile, wsMessageStingify(message) + ',', () => { });
            });
        } catch (e) {
            console.error(e);
            logUtil.error(e.message + e.stack);
        }
        this.emitUpdateLatestWsMessage(id, { id, message });
    }

    updateExtInfo(id, extInfo) {
        this.db.update({ _id: id }, { $set: { ext: extInfo } }, {}, (err) => {
            if (!err) {
                this.emitUpdate(id);
            }
        });
    }

    appendRecord(info) {
        if (info.req.headers.anyproxy_web_req) {
            return -1;
        }
        const thisId = this.globalId++;
        const finalInfo = normalizeInfo(thisId, info);
        this.db.insert(finalInfo);
        this.updateRecordBody(thisId, info);
        this.emitUpdate(thisId, finalInfo);
        return thisId;
    }

    updateRecordBody(id, info) {
        if (id === -1 || !id || typeof info.resBody === 'undefined') return;
        this.getCacheFile(BODY_FILE_PRFIX + id, (err, bodyFile) => {
            if (err) return;
            fs.writeFile(bodyFile, info.resBody, () => { });
        });
    }

    getBody(id, cb) {
        if (id < 0) {
            cb && cb('');
            return;
        }
        this.getCacheFile(BODY_FILE_PRFIX + id, (error, bodyFile) => {
            if (error) {
                cb && cb(error);
                return;
            }
            fs.access(bodyFile, fs.F_OK || fs.R_OK, (err) => {
                if (err) {
                    cb && cb(err);
                } else {
                    fs.readFile(bodyFile, cb);
                }
            });
        });
    }

    getDecodedBody(id, cb) {
        const result = {
            method: '',
            type: 'unknown',
            mime: '',
            content: ''
        };
        this.getSingleRecord(id, (err, doc) => {
            if (!doc || !doc[0]) {
                cb(new Error('未能找到此ID的记录'));
                return;
            }
            result.method = doc[0].method;
            this.getBody(id, (error, bodyContent) => {
                if (error) {
                    cb(error);
                } else if (!bodyContent) {
                    cb(null, result);
                } else {
                    const record = doc[0];
                    const resHeader = record.resHeader || {};
                    try {
                        const headerStr = JSON.stringify(resHeader);
                        const charsetMatch = headerStr.match(/charset='?([a-zA-Z0-9-]+)'?/);
                        const contentType = resHeader['content-type'] || resHeader['Content-Type'];
                        if (charsetMatch && charsetMatch.length) {
                            const currentCharset = charsetMatch[1].toLowerCase();
                            if (currentCharset !== 'utf-8' && iconv.encodingExists(currentCharset)) {
                                bodyContent = iconv.decode(bodyContent, currentCharset);
                            }
                            result.content = bodyContent.toString();
                            result.type = contentType && /application\/json/i.test(contentType) ? 'json' : 'text';
                        } else if (contentType && /image/i.test(contentType)) {
                            result.type = 'image';
                            result.content = bodyContent;
                        } else {
                            result.type = contentType;
                            result.content = bodyContent.toString();
                        }
                        result.mime = contentType;
                        result.fileName = path.basename(record.path);
                        result.statusCode = record.statusCode;
                    } catch (e) {
                        console.error(e);
                    }
                    cb(null, result);
                }
            });
        });
    }

    getDecodedWsMessage(id, cb) {
        if (id < 0) {
            cb && cb([]);
            return;
        }
        this.getCacheFile(WS_MESSAGE_FILE_PRFIX + id, (outError, wsMessageFile) => {
            if (outError) {
                cb && cb(outError);
                return;
            }
            fs.access(wsMessageFile, fs.F_OK || fs.R_OK, (err) => {
                if (err) {
                    cb && cb(err);
                } else {
                    fs.readFile(wsMessageFile, 'utf8', (error, content) => {
                        if (error) {
                            cb && cb(err);
                        }
                        try {
                            content = `[${content.replace(/,$/, '')}]`;
                            const messages = JSON.parse(content);
                            cb(null, messages);
                        } catch (e) {
                            console.error(e);
                            logUtil.error(e.message + e.stack);
                            cb(e);
                        }
                    });
                }
            });
        });
    }

    getSingleRecord(id, cb) {
        this.db.find({ _id: parseInt(id, 10) }, cb);
    }

    getSummaryList(cb) {
        this.db.find({}, cb);
    }

    getRecords(idStart, limit, cb) {
        limit = limit || 10;
        idStart = typeof idStart === 'number' ? idStart : (this.globalId - limit);
        this.db.find({ _id: { $gte: parseInt(idStart, 10) } })
            .sort({ _id: 1 })
            .limit(limit)
            .exec(cb);
    }

    clear() {
        logUtil.printLog('正在清理缓存文件...');
        proxyUtil.deleteFolderContentsRecursive(this.cachePath, true);
    }

    getCacheFile(fileName, cb) {
        const filepath = path.join(this.cachePath, fileName);
        if (filepath.indexOf(this.cachePath) !== 0) {
            cb && cb(new Error('无效的缓存文件路径'));
        } else {
            cb && cb(null, filepath);
            return filepath;
        }
    }
}

module.exports = Recorder;
