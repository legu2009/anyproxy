基于 AnyProxy 进行修改
----------------

[httpsalibaba/anyproxy](https://github.com/alibaba/anyproxy) v4.1.3

用了一些代理工具，感觉还是自己写逻辑控制的比较自由。

默认不会等待请求体和响应体，流式处理

## 配置
```js
connectDetail = {
  host, 
  port, 
  req
}

detailInfo = {
  rawReqInfo: {
      method: req.method,
      url: fullUrl,
      headers: req.headers,
      body: null,
  }, //客户端请求信息
  reqInfo: {
      method: req.method,
      url: fullUrl,
      headers: req.headers,
  }, //转发远程请求信息
  rawResInfo: {
      headers,
      statusCode,
      body: null
  },//远程服务响应信息
  resInfo: {
      headers,
      statusCode,
      body: null
  },//响应客户端信息
  req: req,//客户端请求
  res: res,//远程服务响应，发送远程请求才有
  waitReqData: false, //是否等待请求体，默认不等待，流式处理, isWaitReqData修改才有效
  waitResData: false, //是否等待响应体，默认不等待，流式处理 beforeSendRequest之前修改
  dangerouslyIgnoreUnauthorized: this.dangerouslyIgnoreUnauthorized
};


{

    summary: () => 'AnyProxy的默认规则',
    
    beforeWsClient(wsReqInfo) {

    },
    async isDealConnect(connectDetail) { //https才会触发 connect请求

    },
    async isDealRequest(reqInfo, detailInfo) {
      //默认都拦截请求，return false 才不拦截
    },
    async isWaitReqData(reqInfo, detailInfo) {
      
    },
    async beforeSendRequest(reqInfo, detailInfo) {
    },
    async beforeSendResponse(resInfo, detailInfo) {
    },
}
```

可以通过访问代理服务接口[/__anyproxy/user_rule]()，刷新配置
可以通过访问代理服务接口[/__anyproxy/close]()，关闭服务

