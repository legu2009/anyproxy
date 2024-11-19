'use strict'

// 开始记录并在需要时共享列表
const duckdb = require('duckdb');


const path = require('path');
const fs = require('fs');
const logUtil = require('./log');
const events = require('events');
const iconv = require('iconv-lite');
const fastJson = require('fast-json-stringify');
const proxyUtil = require('./util');
const dayjs = require('dayjs');

//CREATE TABLE t1 (id INTEGER PRIMARY KEY, j VARCHAR);

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

const CACHE_DIR_PREFIX = 'cache_r';

function getDBFilePath() {
    let tmpDir = proxyUtil.getAnyProxyTmpPath();
    const dirPath = path.join(tmpDir, `./db`);
    if (!fs.existsSync(dirPath)) {
        try {
            fs.mkdirSync(dirPath, { recursive: true });
        } catch (err) {
            console.error(`创建目录时出错: ${err}`);
        }
    }
    let fileName = CACHE_DIR_PREFIX + dayjs().format('YYYY_MM_DD');
    proxyUtil.deleteFolderContentsRecursive(dirPath, false, (curPath) => curPath.indexOf(fileName) !== -1);
    return path.join(dirPath, `./` + fileName);
}



class Recorder extends events.EventEmitter {
    constructor(config) {
        super(config);
        this.globalId = 1;
        this.filePath = getDBFilePath();
        this.db = new duckdb.Database(this.filePath);
    }

    async exec(sql, ...args) {
        return new Promise((resolve, reject) => {
            this.db.exec(sql, ...args, function (err, res) {
                if (err) {
                    reject(err);
                } else {
                    resolve(res);
                }
            })
        });
    }

    async all(sql, ...args) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, ...args, function (err, res) {
                if (err) {
                    reject(err);
                } else {
                    resolve(res);
                }
            })
        });
    }


    //网址 方法 状态 类型 大小 时间
    async start() {
        await this.exec(`INSTALL json; LOAD json;`);
        //await this.exec('Drop table if exists log;');
        await this.exec(`CREATE TABLE IF NOT EXISTS log (
            id INTEGER PRIMARY KEY, 
            rawReqUrl VARCHAR,
            rawReqInfo JSON, 
            reqUrl VARCHAR, 
            reqInfo JSON,

            rawReqMethod VARCHAR,
            resStatusCode INTEGER,
            resMimeType VARCHAR,
            resBodySize INTEGER,
            
            clientStartTime BIGINT,
            proxyStartTime BIGINT,
            proxyEndTime BIGINT,
            clientEndTime BIGINT,
            clientEndTimeEnd BIGINT,

            rawReqBody VARCHAR,
            reqBody VARCHAR,
            rawResBody VARCHAR,
            resBody VARCHAR,

            rawResInfo JSON, 
            resInfo JSON,
            
            waitReqData BOOLEAN, 
            waitResData BOOLEAN, 
            dealRequest BOOLEAN
        );`);
        let max = await this.all(`SELECT max(id) as max FROM log`);
        this.globalId = 1;
        if (max) {
            this.globalId = max[0].max + 1;
        }

    }
    appendId() {
        return this.globalId++;
    }
    async updateRawReq(detailInfo) {
        detailInfo.clientStartTime = +Date.now();
        const { rawReqInfo, _recorderId, clientStartTime } = detailInfo;
        await this.all(`INSERT INTO log (id, rawReqUrl, rawReqInfo, clientStartTime, rawReqMethod)
        VALUES (?::INTEGER, ?::VARCHAR, ?::JSON, ?::BIGINT, ?::VARCHAR )`, _recorderId, rawReqInfo.url, JSON.stringify({
            method: rawReqInfo.method,
            url: rawReqInfo.url,
            headers: rawReqInfo.headers,
        }), clientStartTime, rawReqInfo.method);
    }

    async updateUserReq(detailInfo) {
        detailInfo.proxyStartTime = +Date.now();
        const { reqInfo, resInfo, _recorderId, proxyStartTime } = detailInfo;
        let body = resInfo.body;
        if (typeof body === 'string') {
            body = Buffer.from(body);
        }
        await this.all(`UPDATE log SET 
            reqUrl = ?::VARCHAR, reqBody = ?::VARCHAR, reqInfo = ?::JSON, proxyStartTime = ?::BIGINT WHERE id  = ?::INTEGER`,
            reqInfo.url,
            body ? body.toString('base64') : null,
            JSON.stringify({
                method: reqInfo.method,
                url: reqInfo.url,
                headers: reqInfo.headers,
            }), proxyStartTime, _recorderId);
    }

    async updateRawReqBody(detailInfo) {
        const { rawReqInfo, _recorderId } = detailInfo;
        await this.all(`UPDATE log SET rawReqBody = ?::VARCHAR WHERE id  = ?::INTEGER`, rawReqInfo.body.toString('base64'), _recorderId);
    }
    async updateRawResBody(detailInfo) {
        const { rawResInfo, _recorderId } = detailInfo;
        await this.all(`UPDATE log SET rawResBody = ?::VARCHAR WHERE id  = ?::INTEGER`, rawResInfo.body ? rawResInfo.body.toString('base64') : null, _recorderId);
    }

    async updateUserResEnd(detailInfo, useRawRes) {
        detailInfo.clientEndTimeEnd = +Date.now();
        const { rawResInfo, _recorderId, clientEndTimeEnd, waitReqData, waitResData, dealRequest } = detailInfo;
        let body = useRawRes ? rawResInfo.body : detailInfo.resInfo.body;
        if (typeof body === 'string') {
            body = Buffer.from(body);
        }

        await this.all(`UPDATE log SET 
            clientEndTimeEnd = ?::BIGINT, waitReqData = ?::BOOLEAN, waitResData = ?::BOOLEAN, dealRequest = ?::BOOLEAN,
            resBodySize = ?::INTEGER, resBody = ?::VARCHAR
            WHERE id  = ?::INTEGER`,
            clientEndTimeEnd, waitReqData, waitResData, dealRequest,
            body ? Buffer.byteLength(body) / 1024 >> 0 : null,
            body ? body.toString('base64') : null,
            _recorderId
        );
    }

    async updateRawRes(detailInfo) {
        detailInfo.proxyEndTime = +Date.now();
        const { rawResInfo, _recorderId, proxyEndTime } = detailInfo;
        await this.all(`UPDATE log SET
            rawResInfo = ?::JSON, proxyEndTime = ?::BIGINT
        WHERE id  = ?::INTEGER`, JSON.stringify({
            statusCode: rawResInfo.statusCode,
            headers: rawResInfo.headers,
        }), proxyEndTime, _recorderId);
    }

    async updateUserRes(detailInfo) {
        detailInfo.clientEndTime = +Date.now();
        const { resInfo, _recorderId, clientEndTime } = detailInfo;
        await this.all(`UPDATE log SET
            resInfo = ?::JSON, clientEndTime = ?::BIGINT, resStatusCode = ?::INTEGER, resMimeType = ?::VARCHAR
        WHERE id  = ?::INTEGER`, JSON.stringify({
            statusCode: resInfo.statusCode,
            headers: resInfo.headers,
        }), clientEndTime, resInfo.statusCode, resInfo.headers['content-type'] || resInfo.headers['Content-Type'] || '', _recorderId);
    }


    async getLogs() {
        let logs = await this.all(`SELECT id, 
            rawReqUrl,
            rawReqInfo, 
            reqUrl, 
            reqInfo,
            rawReqMethod,
            resStatusCode,
            resMimeType,
            resBodySize,
            clientStartTime,
            proxyStartTime,
            proxyEndTime,
            clientEndTime,
            clientEndTimeEnd,
            rawResInfo, 
            resInfo,
            waitReqData, 
            waitResData, 
            dealRequest FROM log order by id desc`);
        logs.forEach(x => {
            x.clientStartTime = x.clientStartTime?.toString();
            x.proxyStartTime = x.proxyStartTime?.toString();
            x.proxyEndTime = x.proxyEndTime?.toString();
            x.clientEndTime = x.clientEndTime?.toString();
            x.clientEndTimeEnd = x.clientEndTimeEnd?.toString();
        })
        return logs;
    }

    async getLog(id) {
        // let obj = await this.all(`SELECT * FROM log WHERE id = ?::INTEGER`, id);
        // console.log('obj', obj);
        let x = (await this.all(`SELECT * FROM log WHERE id = ?::INTEGER`, id))?.[0];
        if (!x) return {}
        x.clientStartTime = x.clientStartTime?.toString();
        x.proxyStartTime = x.proxyStartTime?.toString();
        x.proxyEndTime = x.proxyEndTime?.toString();
        x.clientEndTime = x.clientEndTime?.toString();
        x.clientEndTimeEnd = x.clientEndTimeEnd?.toString();
        return x;
    }

}

module.exports = Recorder;
