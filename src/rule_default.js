'use strict';

module.exports = {

    summary: () => 'AnyProxy的默认规则',
    async isDealHttpsRequest(connectDetail) {

    },
    beforeWsClient(wsReqInfo) {

    },
    async isWaitReqData(reqInfo, detailInfo) {
    },
    async beforeSendRequest(reqInfo, detailInfo) {
    },
    async beforeSendResponse(resInfo, detailInfo) {
    },
    onError(error, detailInfo) {
        
    },
    onConnectError(error, detailInfo) {
        
    },
};
