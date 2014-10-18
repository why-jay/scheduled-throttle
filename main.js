'use strict';

var THROTTLED = ((Math.random() * 99999999999) >> 0) | 0;

function convertTimezoneToLocalAdjust(timezone) {
    return (timezone.charAt(0) === '+' ? 1 : -1) *
        ((timezone.substr(1, 2) >> 0) * 60 + (timezone.substr(3, 2) >> 0));
}

function convertTimeToMinOfDay(time) {
    return (time.substr(0, 2) >> 0) * 60 + (time.substr(2, 2) >> 0)
}

function create(options) {
    var client = options.client;
    var key = options.key;

    var localAdjustKey = key + ':localAdjust'; // in minutes
    var localChangeTimesKey = key + ':localChangeTimes'; // in minute of day - sorted in increasing order
    var localLastCallTimeKey = key + ':localLastCallTime'; // in UTC minutes

    function clear(cb) {
        client.multi()
            .del(localAdjustKey)
            .del(localChangeTimesKey)
            .del(localLastCallTimeKey)
            .exec(function onResponse(err) {
                if (err) {
                    cb(err);
                    return;
                }
                cb(null);
            });
    }

    function throttle(promiseOrFn, currentDate) {
        return function throttledFunction() {
            var that = this;

            var args = new Array(arguments.length - 1);
            for(var i = 0; i < args.length; ++i) {
                args[i] = arguments[i];
            }
            var cb = arguments[arguments.length - 1];

            function apply() {
                if (typeof promiseOrFn === 'function') {
                    cb(null, promiseOrFn.apply(that, args));
                } else if (promiseOrFn.then) {
                    promiseOrFn.then(function (result) {
                        cb(null, result);
                    });
                } else {
                    throw new Error('The first parameter to .throttle() should be either a promise or a function.');
                }
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
                        apply();

                        var localChangeTimesDef = options.localChangeTimes;
                        var changeTimes = new Array(localChangeTimesDef.length);
                        for (var k = 0; k < changeTimes.length; ++k) {
                            changeTimes[k] = convertTimeToMinOfDay(localChangeTimesDef[k]);
                        }

                        changeTimes.sort(function (a, b) { return a - b; });

                        var multi = client.multi();
                        changeTimes.unshift(localChangeTimesKey);
                        multi.rpush.apply(multi, changeTimes) // .rpush(localChangeTimesKey, changeTimes)
                            .set(localAdjustKey, localAdjust)
                            .set(localLastCallTimeKey, localCurrentMin)
                            .exec(function (err) {
                                if (err) {
                                    cb(err);
                                }
                            });
                        return;
                    }

                    var localLastCallTime = responses[2] | 0;
                    var localChangeTimesStrings = responses[1];
                    var localChangeTimes = new Array(localChangeTimesStrings.length);
                    for (var c = 0; c < localChangeTimes.length; ++c) {
                        localChangeTimes[c] = localChangeTimesStrings[c] >> 0;
                    }

                    function execute() {
                        apply();
                        client.set(localLastCallTimeKey, localCurrentMin, function (err) {
                            if (err) {
                                cb(err);
                            }
                        });
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

                    if (largestTimeSmallerThanCurrent !== largestTimeSmallerThanLastCall) {
                        execute();
                    } else {
                        cb(null, THROTTLED);
                    }
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