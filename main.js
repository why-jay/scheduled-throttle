'use strict';

var THROTTLED = (Math.random() * 99999999999) >> 0;

function convertTimezoneToLocalAdjust(timezone) {
    return (timezone.charAt(0) === '+' ? 1 : -1) *
        ((timezone.substr(1, 2) >> 0) * 60 + (timezone.substr(3, 2) >> 0));
}

function convertTimeToMinOfDay(time) {
    return (time.substr(0, 2) >> 0) * 60 + (time.substr(2, 2) >> 0)
}

function defaultSerialize(result) {
    return JSON.stringify(result);
}

function defaultDeserialize(str) {
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
            throw new Error('The first parameter to .throttle() should be either a function' +
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
                        })
                    }
                );
                fn.apply(that, args);
            }

            client.multi()
                .get(localAdjustKey)
                .lrange(localChangeTimesKey, 0, -1)
                .get(localLastCallTimeKey)
                .exec(function onResponse(err, responses) {
                    if (err) {
                        cb(err);
                        return;
                    }

                    var localAdjust = (responses[0] || convertTimezoneToLocalAdjust(options.timezone)) >> 0;
                    currentDate = currentDate || new Date();
                    var localCurrentMin = ((currentDate.valueOf() + localAdjust * 1000 * 60) / (1000 * 60)) >> 0;

                    if (!responses[0] || !responses[1] || !responses[2]) {
                        fnApply();

                        var localChangeTimesDef = options.localChangeTimes;
                        var changeTimes = new Array(localChangeTimesDef.length);
                        for (var k = 0; k < changeTimes.length; ++k) {
                            changeTimes[k] = convertTimeToMinOfDay(localChangeTimesDef[k]);
                        }

                        changeTimes.sort(function (a, b) { return a - b; });

                        var multi = client.multi();

                        var expire = options.inactivityExpire;
                        if (expire) {
                            changeTimes.unshift(localChangeTimesKey);
                            multi.rpush.apply(multi, changeTimes) // .rpush(localChangeTimesKey, changeTimes)
                                .expire(localChangeTimesKey, expire)
                                .setex(localAdjustKey, expire, localAdjust)
                                .setex(localLastCallTimeKey, expire, localCurrentMin)
                                .exec(function (err) {
                                    if (err) {
                                        cb(err);
                                    }
                                });
                        } else {
                            changeTimes.unshift(localChangeTimesKey);
                            multi.rpush.apply(multi, changeTimes) // .rpush(localChangeTimesKey, changeTimes)
                                .set(localAdjustKey, localAdjust)
                                .set(localLastCallTimeKey, localCurrentMin)
                                .exec(function (err) {
                                    if (err) {
                                        cb(err);
                                    }
                                });
                        }
                        return;
                    }

                    var localLastCallTime = responses[2] | 0;
                    var localChangeTimesStrings = responses[1];
                    var localChangeTimes = new Array(localChangeTimesStrings.length);
                    for (var c = 0; c < localChangeTimes.length; ++c) {
                        localChangeTimes[c] = localChangeTimesStrings[c] >> 0;
                    }

                    var localCurrentMinOfDay = localCurrentMin % (60 * 24);
                    var localLastCallMinOfDay = localLastCallTime % (60 * 24);

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

                    var shouldExecute = largestTimeSmallerThanCurrent !== largestTimeSmallerThanLastCall;

                    expire = options.inactivityExpire;
                    multi = client.multi();
                    if (expire) {
                        multi.expire(localLastCallTimeKey, expire)
                            .expire(localAdjustKey, expire)
                            .expire(localChangeTimesKey, expire);
                    }
                    if (shouldExecute) {
                        multi = multi.set(localLastCallTimeKey, localCurrentMin);
                    }
                    multi.exec(function (err) {
                        if (err) {
                            cb(err);
                            return;
                        }

                        if (shouldExecute) {
                            fnApply();
                        } else {
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
                    });
                });
        };
    }

    return {
        clear: clear,
        throttle: throttle
    };
}

exports.THROTTLED = THROTTLED;
exports.create = create;