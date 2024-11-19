'use strict';

module.exports = {

    summary: () => 'AnyProxy的默认规则',

    beforeWsClient(wsReqInfo) {

    },
    
    async isDealConnect(connectDetail) {

    },
    async isDealRequest(reqInfo, detailInfo) {

    },
    async isWaitReqData(reqInfo, detailInfo) {
    },
    async beforeSendRequest(reqInfo, detailInfo) {
    },
    async beforeSendResponse(resInfo, detailInfo) {
    },
    onError(error, detailInfo) {
        
    },
    onConnectError(error, connectDetail) {
        
    },
    onClientSocketError(error, connectDetail) {
        
    },
};
