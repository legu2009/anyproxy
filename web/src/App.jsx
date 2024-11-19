import { useState, useEffect, useRef } from 'react'
import { action, makeAutoObservable, extendObservable, runInAction } from 'mobx'
import { Button, Drawer, Space, Tabs, Collapse } from 'antd';
import { useLocalStore, useObserver, observer } from 'mobx-react-lite'
import { themes } from '@visactor/vtable'
import * as VTable from '@visactor/vtable';
import { ListTable } from '@visactor/react-vtable'
import { DiffEditor } from '@monaco-editor/react';
import './App.css'

const { Panel } = Collapse;

class Store {

    constructor() {
        extendObservable(this, { records: [], showInfo: false });
        extendObservable(this, { recordMap: {}, showLogInfo: {} }, { deep: false });
        this.getRecords();

        this.items = [
            {
                label: '标头',
                key: 'header',
                className: 'hoverShowScrollBar',
                children: <LogHeader store={this} />
            },
            {
                label: '比较',
                key: 'diff',
                children: <LogDiffEditor store={this} />
            },
            {
                label: '预览',
                key: 'preview',
                children: <div>响应</div>
            },
            {
                label: '响应',
                key: 'response',
                children: <div>响应</div>
            }
        ]
    }

    getRecords() {
        fetch('/__anyproxy/api/logs')
            .then(res => res.json())
            .then(action(list => {
                let map = {};
                this.records = list.map(item => {
                    map[item.id] = item;
                    item.resDuration = item.clientEndTimeEnd - item.clientStartTime + '毫秒';
                    return item.id
                });
                this.recordMap = map;
            }));
    }

    onInfoOpen() {
        runInAction(() => {
            this.showInfo = true;
        })
    }
    onInfoClose = () => {
        runInAction(() => {
            this.showInfo = false;
        })
    }

    getReqCode() {
        let { showLogInfo } = this;
        let { rawResInfo, rawReqInfo, reqInfo, resInfo } = showLogInfo;
        let clientCode = rawReqInfo.method + ' ' + rawReqInfo.url + '\n\n';
        let proxyCode = reqInfo.method + ' ' + reqInfo.url + '\n\n';
        function addCode(clientHeaders, proxyHeaders) {
            let max = 0;
            let clientKeys = Object.keys(clientHeaders || {});
            let proxyKeys = Object.keys(proxyHeaders || {});
            clientKeys.forEach(key => {
                max = Math.max(max, key.length);
            });
            proxyKeys.forEach(key => {
                max = Math.max(max, key.length);
            });
            if (max > 15) {
                max = 15;
            }
            clientKeys.forEach(key => {
                clientCode += key.padEnd(max) + ':' + clientHeaders[key] + '\n';
            });
            proxyKeys.forEach(key => {
                proxyCode += key.padEnd(max) + ':' + proxyHeaders[key] + '\n';
            });
        }
        addCode(rawReqInfo.headers, reqInfo.headers);

        clientCode += ''.padEnd(60, '-') + '\n' + resInfo.statusCode + '\n';
        proxyCode += ''.padEnd(60, '-') + '\n' + rawResInfo.statusCode + '\n';

        addCode(resInfo.headers, rawResInfo.headers);

        return { clientCode, proxyCode }
    }

    onTableClick = (opt) => {
        let id = this.tableInstance.getRecordByCell(opt.col, opt.row)?.id;
        fetch('/__anyproxy/api/log?id=' + id)
            .then(res => res.json())
            .then(action(obj => {
                obj.rawReqInfo = JSON.parse(obj.rawReqInfo);
                obj.rawResInfo = JSON.parse(obj.rawResInfo);
                if (obj.reqInfo) {
                    obj.reqInfo = JSON.parse(obj.reqInfo);
                }
                if (obj.resInfo) {
                    obj.resInfo = JSON.parse(obj.resInfo);
                }
                // if (obj.rawReqBody) {
                //     console.log(this.base64ToString(obj.rawReqBody))
                //     //obj.rawReqBody = Buffer.from();
                // }
                // if (obj.rawResBody) {
                //     try {
                //         // 假设 compressedData 是一个 Uint8Array

                //         const binaryString = atob(obj.rawResBody);
                //         const length = binaryString.length;
                //         const uint8Array = new Uint8Array(length);

                //         for (let i = 0; i < length; i++) {
                //             uint8Array[i] = binaryString.charCodeAt(i);
                //         }
                //         console.log(uint8Array);

                //         const decompressedData = pako.inflate(uint8Array);
                //         return new TextDecoder().decode(decompressedData);
                //     } catch (err) {
                //         console.error('解压失败:', err);
                //         return null;
                //     }
                // }
                // if (obj.reqBody) {
                //     console.log(hexToString(obj.reqBody))
                // }
                if (obj.resBody) {
                    obj.resBody = atob(obj.resBody)
                }
                this.showLogInfo = obj;
                this.showInfo = true;
            }));
    }

    onTableReady = (table) => {
        this.tableInstance = table;
        table.off(VTable.ListTable.EVENT_TYPE.CLICK_CELL, this.onTableClick);
        table.on(VTable.ListTable.EVENT_TYPE.CLICK_CELL, this.onTableClick)
    }

    getClientReqHeaders = () => {
        let res = [
            [this.showLogInfo.rawReqMethod + ' ' + this.showLogInfo.rawReqUrl],
        ];
        let headers = this.showLogInfo.rawReqInfo.headers;
        for (let key in headers) {
            res.push([key, headers[key]])
        }
        return res
    }


    getClientResHeaders = () => {
        const showLogInfo = this.showLogInfo;
        let headers = showLogInfo.resInfo?.headers ?? showLogInfo.rawResInfo.headers;
        let res = [];
        for (let key in headers) {
            res.push([key, headers[key]])
        }
        return res
    }

    getProxyReqHeaders = () => {
        let reqInfo = this.showLogInfo.reqInfo;
        let res = [
            [reqInfo.method + ' ' + reqInfo.url],
        ];
        let headers = reqInfo.headers;
        for (let key in headers) {
            res.push([key, headers[key]])
        }
        return res
    }


    getProxyResHeaders = () => {
        const showLogInfo = this.showLogInfo;
        let headers = showLogInfo.rawResInfo?.headers ?? {};
        let res = [];
        for (let key in headers) {
            res.push([key, headers[key]])
        }
        return res
    }

}

let theme = themes.DEFAULT;
theme.internalTheme.obj.headerStyle.fontSize = 12;
theme.internalTheme.obj.bodyStyle.fontSize = 12;

const LogDiffEditor = observer(function ({ store }) {
    const { showLogInfo } = store;
    let { clientCode, proxyCode } = store.getReqCode();
    const options = {
        //renderSideBySide: false
    };

    return  
})
const LogTable = observer(function ({ store }) {
    const { records: _records, recordMap } = store;
    const records = _records.map(id => recordMap[id]);
    const columns = [
        {
            field: 'id',
            title: 'ID1',
            width: 80,
            sort: true
        },
        {
            field: 'rawReqUrl',
            title: '网址',
            sort: true,
            width: 'auto'
        },
        {
            field: 'rawReqMethod',
            title: '方法',
            width: 60,
        },
        {
            field: 'resStatusCode',
            title: '状态',
            width: 60
        },
        {
            field: 'resMimeType',
            title: '类型',
            width: 120,
        },
        {
            field: 'resBodySize',
            title: '大小',
            width: 80,
            style: {
                textAlign: 'right'
            }
        },
        {
            field: 'resDuration',
            title: '时间',
            width: 80,
            style: {
                textAlign: 'right'
            }
        }
    ];
    return <ListTable option={{
        records,
        columns,
        defaultRowHeight: 30,
        widthMode: 'adaptive',
        theme,
        keyboardOptions: {
            moveEditCellOnArrowKeys: true,
            copySelected: true
        },
        hover: {
            highlightMode: 'row'
        },

    }} height={'100%'} onReady={store.onTableReady} />
});

const LogInfo = observer(function ({ store }) {
    const { showLogInfo } = store;
    return <Tabs
        className='drawer-info-tabs'
        defaultActiveKey="1"
        destroyInactiveTabPane={true}
        size="small"
        items={store.items}
    />
});

const LogHeader = observer(function ({ store }) {
    const { showLogInfo } = store;
    return <Collapse className='drawer-info-header'>
        <Panel header="常规" >
            <LogHeaderSummary store={store} />
        </Panel>
        <Panel header={`请求标头`} >
            <LogHeaderlist fn={store.getClientReqHeaders} />
        </Panel>
        <Panel header="响应标头" >
            <LogHeaderlist fn={store.getClientResHeaders} />
        </Panel>
        <Panel header={`请求标头 Proxy`} >
            <LogHeaderlist fn={store.getProxyReqHeaders} />
        </Panel>
        <Panel header="响应标头 Proxy" >
            <LogHeaderlist fn={store.getProxyResHeaders} />
        </Panel>
    </Collapse>
});

const LogHeaderSummary = observer(function ({ store, type = '' }) {
    const { showLogInfo } = store;
    if (type === 'proxy') {
        return <LogHeaderlist fn={() => ([
            ['请求网址', showLogInfo.reqInfo.url],
            ['请求方法', showLogInfo.reqInfo.method],
            ['状态代码', showLogInfo.resInfo.statusCode],
        ])} />
    }
    return <LogHeaderlist fn={() => ([
        ['请求网址', showLogInfo.rawReqUrl],
        ['请求方法', showLogInfo.rawReqMethod],
        ['状态代码', showLogInfo.resStatusCode],
    ])} />
})

const LogHeaderlist = observer(function ({ fn }) {
    const headers = fn();
    return <div className='ligInfo-list'>
        {
            headers.map(([key, value]) => {
                return <div className='ligInfo-list-item'>
                    {value === undefined ? <div>{key}</div> : <>
                        <div>{key}:</div>
                        <div dangerouslySetInnerHTML={{ __html: value }} />
                    </>}
                </div>
            })
        }
    </div >
})


export default function App() {
    const store = useLocalStore(() => new Store());
    return useObserver(() => {
        return (
            <>
                <LogTable store={store} />
                <Drawer
                    title={null}
                    mask={false}
                    width={1200}
                    className='drawer-info'
                    placement="right"
                    size='large'
                    onClose={store.onInfoClose}
                    open={store.showInfo}
                >
                    <LogInfo store={store} />
                </Drawer>
            </>

        )
    })
}




// const tableInstance =new ListTable(options);
//   ;



/*theme: {
                    headerStyle: {
                        fontSize: 12,
                        bgColor: 'rgb(247,250,253)',
                        borderColor: 'rgb(211,257,253)'
                    },
                    bodyStyle: {
                        fontSize: 12,
                        borderColor: 'rgb(211,257,253)'
                    }
                }*/
