
const TASK_ONGOING = 0;
const TASK_COMPLETE = 1;

class CachedTaskManager {
    constructor() {
        this.callbackList = {};
    }

    addTask(name, action, cb) {
        let task = this.callbackList[name];
        if (task) {
            if (task.status === TASK_COMPLETE) { // 已完成
                cb && cb.apply(null, task.result);
            } else if (task.status === TASK_ONGOING) { // 进行中
                task.callbackList.push(cb);
            }
        } else {
            task = this.callbackList[name] = {
                status: TASK_ONGOING,
                result: null,
                callbackList: [cb]
            };

            action.call(null, (...args) => {
                task.result = args;
                task.status = TASK_COMPLETE;
                let cb;
                while (cb = task.callbackList.shift()) {
                    cb && cb.apply(null, task.result);
                }
            });
        }
    }

    removeTask(name) {
        delete this.callbackList[name];
    }
}

module.exports = CachedTaskManager;
