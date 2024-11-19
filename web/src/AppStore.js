import { observable, action, makeAutoObservable } from 'mobx'

export default class Store {

    @observable
    records = [];

    recordMap = {};

    constructor() {
        makeAutoObservable(this);
    }

    getRecords() {
        fetch('/__anyproxy/api/logs')
            .then(res => res.json())
            .then(action(data => {
                this.records = data.map(item => item.id);
                this.recordMap = data.reduce((acc, cur) => {
                    acc['' + cur.id] = cur;
                    return acc;
                }, {});
            }));
    }
}
