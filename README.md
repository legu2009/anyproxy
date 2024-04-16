AnyProxy
forked from [httpsalibaba/anyproxy](https://github.com/alibaba/anyproxy) v4.1.3
----------------

用了一些代理工具，感觉还是自己写逻辑控制的比较自由。

使用代理进行开发的时候，会发现请求变慢了很多，主要是代理需要实现修改请求体，响应体，所有会把数据都进行接收

本项目增加一些配置，可以支持请求流式，响应流式

## 配置

```js
{
    summary: "a rule to hack response",
    *beforeDealHttpsRequest({ host, _req }) {
      //return false 不转发（host 域名端口）
      return true;
    },
    *beforeFetchReqData(requestDetail) {
      //return false 不修改请求内容，默认返回true
      return false;
    },
    beforeWsClient(wsReqInfo) {
      //ws的修改，一般没用，转发主要是 noWsHeaders.origin
      return wsReqInfo;
    },
    *beforeSendRequest(requestDetail) {
      return {
        _directlyRemoteResponse: true //增加属性，true 使用远程返回内容, false 可以在 beforeSendResponse 中修改
      };
    },
    *beforeSendResponse(requestDetail, responseDetail) {
      return responseDetail;
    },
  }
```

增加代码路径配置，可以通过访问代理服务接口[/__anyproxy/user_rule]()，刷新配置
主要是发现socket代理服务 node-dev重启有问题

```
ruleFilePath: './rule.js',
```
没尝试下面方式
```js
process.on('SIGINT', () => {
    try {
      proxyServer && proxyServer.close();
    } catch (e) {
      console.error(e);
    }
    process.exit();
});
```

增加一些util方式，支持whistle配置