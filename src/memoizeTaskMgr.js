
const TASK_ONGOING = 0;
const TASK_COMPLETE = 1;

class MemoizeTaskManager {
    constructor() {
        this._taskMap = {};
    }

    addTask(key, func, callback) {
        let task = this._taskMap[key];
        if (task) {
            if (task.status === TASK_COMPLETE) { // 已完成
                callback && callback.apply(null, task.result);
            } else if (task.status === TASK_ONGOING) { // 进行中
                task.callbackList.push(callback);
            }
            return;
        }
        task = this._taskMap[key] = {
            status: TASK_ONGOING,
            result: null,
            callbackList: [callback]
        };

        func.call(null, (...args) => {
            task.result = args;
            task.status = TASK_COMPLETE;
            let callback;
            while (callback = task.callbackList.shift()) {
                callback.apply(null, task.result);
            }
        });
    }

    removeTask(key) {
        delete this._taskMap[key];
    }
}

module.exports = MemoizeTaskManager;
