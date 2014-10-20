'use strict';

var NEED_INIT = 12341; // module-internal constant
var SHOULD_EXECUTE = 2390243; // module-internal constant
var SHOULD_NOT_EXECUTE = 2352352; // module-internal constant

var THROTTLED = (Math.random() * 99999999999) >> 0; // public constant

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
    var client = options.client;
    var key = options.key;

    var serialize = options.serialize || defaultSerialize;
    var deserialize = options.deserialize || defaultDeserialize;

    var localAdjustKey = key + ':localAdjust'; // in minutes
    var localChangeTimesKey = key + ':localChangeTimes'; // in minute of day - sorted in increasing order
    var localLastCallTimeKey = key + ':localLastCallTime'; // in UTC minutes
    var lastCallResultKey = key + ':lastCallResult';

    function checkStatus(cb, currentDate) {
        client.multi()
            .get(localAdjustKey)
            .lrange(localChangeTimesKey, 0, -1)
            .get(localLastCallTimeKey)
            .exec(function onResponse(err, responses) {
                if (err) {
                    cb(err);
                    return;
                }

                if (!responses[0] || !responses[1] || !responses[2]) {
                    cb(null, {status: NEED_INIT, localAdjust: convertTimezoneToLocalAdjust(options.timezone)});
                    return;
                }

                currentDate = currentDate || new Date();

                var localAdjust = responses[0] >> 0;
                var localCurrentMin = convertDateToLocalMin(currentDate, localAdjust);
                var localLastCallTime = responses[2] | 0;
                var localChangeTimesStrings = responses[1];
                var localChangeTimes = [];
                for (var c = 0; c < localChangeTimesStrings.length; ++c) {
                    localChangeTimes.push(localChangeTimesStrings[c] >> 0);
                }
                var localCurrentMinOfDay = convertMinToMinOfDay(localCurrentMin);
                var localLastCallMinOfDay = convertMinToMinOfDay(localLastCallTime);

                var largestTimeSmallerThanCurrent = -1;
                for (var j = localChangeTimes.length - 1; j >= 0; --j) {
                    if (localCurrentMinOfDay >= localChangeTimes[j]) {
                        largestTimeSmallerThanCurrent = localChangeTimes[j];
                        break;
                    }
                }

                var largestTimeSmallerThanLastCall = -1; // if different day, always -1
                if ((localLastCallTime / (60 * 24)) >> 0 === (localCurrentMin / (60 * 24)) >> 0) {
                    for (; j >= 0; --j) {
                        if (localLastCallMinOfDay >= localChangeTimes[j]) {
                            largestTimeSmallerThanLastCall = localChangeTimes[j];
                            break;
                        }
                    }
                }

                if (largestTimeSmallerThanCurrent !== largestTimeSmallerThanLastCall) {
                    cb(null, {status: SHOULD_EXECUTE, localAdjust: localAdjust});
                } else {
                    cb(null, {status:SHOULD_NOT_EXECUTE, localAdjust: localAdjust});
                }
            });
    }

    function clear(cb) {
        client.multi()
            .del(localAdjustKey)
            .del(localChangeTimesKey)
            .del(localLastCallTimeKey)
            .del(lastCallResultKey)
            .exec(function onResponse(err) {
                if (err) {
                    cb(err);
                    return;
                }
                cb(null);
            });
    }

    function throttle(fn, currentDate) {
        if (typeof fn !== 'function') {
            throw new Error('The first parameter to .throttle() should be a function' +
                ' whose last parameter is a node-style callback.');
        }

        return function throttledFunction() {
            var that = this;

            var args = new Array(arguments.length - 1);
            for(var i = 0; i < args.length; ++i) {
                args[i] = arguments[i];
            }
            var cb = arguments[arguments.length - 1];

            function fnApply() {
                args.push(!options.preserveResult ? cb :
                    function fnCallback(err, res) {
                        client.set(lastCallResultKey, serialize(res), function onSetLastCallResultKey(err) {
                            if (err) {
                                cb(err);
                                return;
                            }

                            cb(null, res);
                        });
                    }
                );
                fn.apply(that, args);
            }

            checkStatus(function (err, checkResult) {
                if (err) {
                    cb(err);
                    return;
                }

                currentDate = currentDate || new Date();

                var status = checkResult.status;
                var localAdjust = checkResult.localAdjust;
                var localCurrentMin = convertDateToLocalMin(currentDate, localAdjust);

                switch (status) {
                    case NEED_INIT:
                        fnApply();

                        var localChangeTimesDef = options.localChangeTimes;
                        var changeTimes = new Array(localChangeTimesDef.length);
                        for (var k = 0; k < changeTimes.length; ++k) {
                            changeTimes[k] = convertTimeToMinOfDay(localChangeTimesDef[k]);
                        }

                        changeTimes.sort(function (a, b) { return a - b; });

                        changeTimes.unshift(localChangeTimesKey);
                        var multi = client.multi();
                        multi.rpush.apply(multi, changeTimes) // .rpush(localChangeTimesKey, changeTimes)
                            .set(localAdjustKey, localAdjust)
                            .set(localLastCallTimeKey, localCurrentMin)
                            .exec(function (err) {
                                if (err) {
                                    cb(err);
                                }
                            });
                        break;
                    case SHOULD_EXECUTE:
                        fnApply();
                        client.set(localLastCallTimeKey, localCurrentMin);
                        break;
                    default: // SHOULD_NOT_EXECUTE
                        var preserveResult = options.preserveResult;
                        if (!preserveResult) {
                            cb(null, THROTTLED);
                        } else {
                            client.get(lastCallResultKey, function (err, res) {
                                if (err) {
                                    cb(err);
                                    return;
                                }

                                cb(null, preserveResult ? deserialize(res) : res);
                            })
                        }
                }

                var expire = options.inactivityExpire;
                if (expire) {
                    client.multi()
                        .expire(localLastCallTimeKey, expire)
                        .expire(localAdjustKey, expire)
                        .expire(localChangeTimesKey, expire)
                        .expire(lastCallResultKey, expire)
                        .exec(function (err) {
                            if (err) {
                                cb(err);
                            }
                        });
                }
            }, currentDate);
        };
    }

    function willExecute(cb, currentDate) {
        checkStatus(function (err, checkResult) {
            if (err) {
                cb(err);
                return;
            }

            var status = checkResult.status;

            if (status === NEED_INIT || status === SHOULD_EXECUTE) {
                cb(null, true);
                return;
            }

            // SHOULD_NOT_EXECUTE
            cb(null, false);
        }, currentDate);
    }

    return {
        clear: clear,
        throttle: throttle,
        willExecute: willExecute
    };
}

exports.THROTTLED = THROTTLED;
exports.create = create;