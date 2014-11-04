'use strict';

require('6to5/polyfill');
require('source-map-support').install();

var THROTTLED = 'THROTTLED'; // public varant

var NEED_INIT = 'NEED_INIT'; // module-internal varant
var SHOULD_EXECUTE = 'SHOULD_EXECUTE'; // module-internal varant
var SHOULD_NOT_EXECUTE = 'SHOULD_NOT_EXECUTE'; // module-internal varant

var Bluebird = require('bluebird');

function convertDateToLocalMin(date, localAdjust) {
    return ((date.valueOf() + localAdjust * 1000 * 60) / (1000 * 60)) >> 0;
}

function convertMinToMinOfDay(min) {
    return min % (60 * 24);
}

function convertTimeToMinOfDay(time) {
    return (time.substr(0, 2) >> 0) * 60 + (time.substr(2, 2) >> 0)
}

function convertTimezoneToLocalAdjust(timezone) {
    return (timezone.charAt(0) === '+' ? 1 : -1) *
        ((timezone.substr(1, 2) >> 0) * 60 + (timezone.substr(3, 2) >> 0));
}

function defaultSerialize(result) {
    if (result === undefined) {
        return '__schthrot_undefined__';
    }
    return JSON.stringify(result);
}

function defaultDeserialize(str) {
    if (str === '__schthrot_undefined__') {
        return undefined;
    }
    return JSON.parse(str);
}

function create(options) {
    var client = Bluebird.promisifyAll(options.client);
    var key = options.key;

    var serialize = options.serialize || defaultSerialize;
    var deserialize = options.deserialize || defaultDeserialize;

    var localAdjustKey = key + ':localAdjust'; // in minutes
    var localChangeTimesKey = key + ':localChangeTimes'; // in minute of day - sorted in increasing order
    var localLastCallTimeKey = key + ':localLastCallTime'; // in UTC minutes
    var lastCallResultKey = key + ':lastCallResult';

    var checkStatusAsync = Bluebird.coroutine(function* (currentDate = new Date()) {
        var result = yield Bluebird.promisifyAll(
            client.multi()
                .get(localAdjustKey)
                .lrange(localChangeTimesKey, 0, -1)
                .get(localLastCallTimeKey)
        ).execAsync();

        if (!result) {
            return {status: NEED_INIT, localAdjust: convertTimezoneToLocalAdjust(options.timezone)};
        }

        var [localAdjustString, localChangeTimesStrings, localLastCallTimeString] = result;

        if (!localAdjustString || !localChangeTimesStrings || !localLastCallTimeString) {
            return {status: NEED_INIT, localAdjust: convertTimezoneToLocalAdjust(options.timezone)};
        }

        var localAdjust = localAdjustString >> 0;
        var localChangeTimes = localChangeTimesStrings.map(str => str >> 0);
        var localLastCallTime = localLastCallTimeString >> 0;

        var localCurrentMin = convertDateToLocalMin(currentDate, localAdjust);
        var localCurrentMinOfDay = convertMinToMinOfDay(localCurrentMin);
        var localLastCallMinOfDay = convertMinToMinOfDay(localLastCallTime);

        var timesSmallerThanCurrent = localChangeTimes.filter(time => time <= localCurrentMinOfDay);
        var largestTimeSmallerThanCurrent = timesSmallerThanCurrent.length === 0 ? -1 :
            timesSmallerThanCurrent[timesSmallerThanCurrent.length - 1]; // last is largest - already sorted

        var areDifferentDays = (localLastCallTime / (60 * 24)) >> 0 !== (localCurrentMin / (60 * 24)) >> 0;
        var largestTimeSmallerThanLastCall = areDifferentDays ? -1 : // if different day, stays -1
            (() => {
                var timesSmallerThanLastCall = localChangeTimes.filter(time => time <= localLastCallMinOfDay);
                return timesSmallerThanLastCall.length === 0 ? -1 :
                    timesSmallerThanLastCall[timesSmallerThanLastCall.length - 1]; // last is largest - already sorted
            })();

        return {
            localAdjust: localAdjust,
            status: largestTimeSmallerThanCurrent !== largestTimeSmallerThanLastCall ?
                SHOULD_EXECUTE : SHOULD_NOT_EXECUTE
        };
    });

    var clearAsync = Bluebird.coroutine(function* () {
        yield Bluebird.promisifyAll(
            client.multi()
                .del(localAdjustKey)
                .del(localChangeTimesKey)
                .del(localLastCallTimeKey)
                .del(lastCallResultKey)
        ).execAsync();
    });

    function throttle(currentDate, fn) {
        if (!(currentDate instanceof Date)) {
            fn = currentDate;
            currentDate = new Date();
        }

        if (typeof fn !== 'function') {
            throw new Error('The first parameter to .throttle() should be a function' +
                ' whose last parameter is a node-style callback.');
        }

        var throttledFunctionAsync = Bluebird.coroutine(function* (...args) {
            var checkResult = yield checkStatusAsync(currentDate);
            var localAdjust = checkResult.localAdjust;
            var localCurrentMin = convertDateToLocalMin(currentDate, checkResult.localAdjust);

            var that = this;
            var fnExecuteAsync = Bluebird.coroutine(function* () {
                var fnAsync = Bluebird.promisify(fn.bind(that));
                var fnResult = yield fnAsync(...args);

                var multi = client.multi()
                    .set(localLastCallTimeKey, localCurrentMin);
                if (options.preserveResult) {
                    multi = multi.set(lastCallResultKey, serialize(fnResult));
                }
                yield Bluebird.promisifyAll(multi).execAsync();

                return fnResult;
            });

            var fnExecuteResult = null;
            switch (checkResult.status) {
                case NEED_INIT:
                    var changeTimes =
                        options.localChangeTimes
                            .map(time => convertTimeToMinOfDay(time))
                            .sort(function (a, b) { return a - b; });
                    yield Bluebird.promisifyAll(
                        client.multi()
                            .rpush(localChangeTimesKey, ...changeTimes)
                            .set(localAdjustKey, localAdjust)
                    ).execAsync();
                    fnExecuteResult = yield fnExecuteAsync();
                    break;
                case SHOULD_EXECUTE:
                    fnExecuteResult = yield fnExecuteAsync();
                    break;
                default: // SHOULD_NOT_EXECUTE
                    fnExecuteResult = !options.preserveResult ? THROTTLED :
                        deserialize(yield client.getAsync(lastCallResultKey));
            }

            var expire = options.inactivityExpire;
            if (expire) {
                yield Bluebird.promisifyAll(
                    client.multi()
                        .expire(localLastCallTimeKey, expire)
                        .expire(localAdjustKey, expire)
                        .expire(localChangeTimesKey, expire)
                        .expire(lastCallResultKey, expire)
                ).execAsync();
            }

            return fnExecuteResult;
        });

        return function throttledFunction(...args) {
            var cb = args.pop();
            throttledFunctionAsync.bind(this)(...args).then(res => cb(null, res)).catch(err => cb(err));
        }
    }

    var willExecuteAsync = Bluebird.coroutine(function* (currentDate = new Date()) {
        var checkResult = yield checkStatusAsync(currentDate);

        var status = checkResult.status;

        if (status === NEED_INIT || status === SHOULD_EXECUTE) {
            return true;
        }

        // SHOULD_NOT_EXECUTE
        return false;
    });

    return {
        clear: function (cb) {
            clearAsync.bind(this)().then(res => cb(null, res)).catch(err => cb(err));
        },
        throttle: throttle,
        willExecute: function (currentDate, cb) {
            if (!(currentDate instanceof Date)) {
                cb = currentDate;
                currentDate = new Date();
            }
            willExecuteAsync.bind(this)(currentDate).then(res => cb(null, res)).catch(err => cb(err));
        }
    };
}

exports.THROTTLED = THROTTLED;
exports.create = create;