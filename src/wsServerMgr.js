/**
 * 管理WebSocket服务器
 */
const { WebSocketServer } = require('ws');
const logUtil = require('./log.js');


function createWsServer(config) {
    const wss = new WebSocketServer({
        server: config.server
    });

    wss.on('connection', config.connHandler);

    wss.on('headers', headers => {
        headers.push('x-anyproxy-websocket:true');
    });

    wss.on('error', e => {
        logUtil.error(`WebSocket代理错误: ${e.message},\r\n ${e.stack}`);
        console.error('WebSocket代理发生错误:', e)
    });

    wss.on('close', e => {
        console.error('==> 正在关闭WebSocket服务器');
    });

    return wss;
}

module.exports.createWsServer = createWsServer;
