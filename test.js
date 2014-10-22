'use strict';

require('6to5/polyfill');
require('source-map-support').install();

const TEST_KEY_NAME = 'schthrot_test:10';
const EXPIRE = 1; // seconds

const scheduledThrottle = require('./es5');

const Bluebird = require('bluebird');
const assert = require('assert');
const redisClient = Bluebird.promisifyAll(require('redis').createClient());

const pad = function (n, width, z) {
    // http://stackoverflow.com/questions/10073699
    z = z || '0';
    n = n + '';
    return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
};

const timezoneStr = (() => {
    const timezoneOffset = new Date().getTimezoneOffset();
    const timezoneSign = timezoneOffset <= 0 ? '+' : '-';
    const timezoneVal = Math.abs(timezoneOffset);

    return timezoneSign + pad(Math.floor(timezoneVal / 60), 2) + pad(timezoneVal % 60, 2);
})();

const startDate = new Date();
const startHour = startDate.getHours();
const startMin = startDate.getMinutes();

const x = 1;
const y = 10;
const b = 10;

Bluebird.coroutine(function* () {
    const throttler = Bluebird.promisifyAll(scheduledThrottle.create({
        client: redisClient,
        key: TEST_KEY_NAME,
        timezone: timezoneStr,
        localChangeTimes: [
            '0400',
            '1400',
            '2200',
            pad(startHour, 2) + pad(startMin + 1, 2),
            pad(startHour, 2) + pad(startMin + 2, 2)
        ],
        inactivityExpire: EXPIRE // seconds
    }));

    const obj = {
        a: 10,
        throttledFnAsync: Bluebird.promisify(
            throttler.throttle(function (x, cb) {
                cb(null, x + this.a);
            })
        )
    };

    yield throttler.clearAsync();
    assert.strictEqual(yield throttler.willExecuteAsync(), true);

    assert.strictEqual(yield obj.throttledFnAsync(x), x + obj.a);
    assert.strictEqual(yield throttler.willExecuteAsync(), false);

    yield Bluebird.delay(EXPIRE * 1000 + 500); // milliseconds, add 500ms just in case
    assert.notStrictEqual(yield obj.throttledFnAsync(x), scheduledThrottle.THROTTLED, 'Keys did not expire');

    let currentDate = new Date(startDate);
    for (let minuteHitCount = 0; true; currentDate.setSeconds(currentDate.getSeconds() + 1)) {
        process.stdout.write('.');

        let simulatedThrottledFn = throttler.throttle(currentDate, function (y, cb) {
            cb(null, y + this.b);
        }.bind({b}));

        let result = yield Bluebird.promisify(simulatedThrottledFn)(y);

        if (result === scheduledThrottle.THROTTLED) {
            assert.strictEqual(yield throttler.willExecuteAsync(currentDate), false);
            assert.strictEqual((startDate.getMinutes() + minuteHitCount) % 60, currentDate.getMinutes());
        } else {
            assert.strictEqual(yield throttler.willExecuteAsync(currentDate), false);
            minuteHitCount += 1;
            assert.strictEqual((startDate.getMinutes() + minuteHitCount) % 60, currentDate.getMinutes());
            assert.strictEqual(result, y + b);

            if (minuteHitCount === 2) {
                break;
            }
        }
    }

    for (let hourHitCount = 0, callCount = 0; true; currentDate.setHours(currentDate.getHours() + 1), ++hourHitCount) {
        process.stdout.write('.');

        let simulatedThrottledFn = throttler.throttle(currentDate, (y, cb) => cb(null, y + b));

        let result = yield Bluebird.promisify(simulatedThrottledFn)(y);

        if (result === scheduledThrottle.THROTTLED) {
            assert.strictEqual((startDate.getHours() + hourHitCount) % 24, currentDate.getHours());
        } else {
            assert(currentDate.getHours() === 4 || currentDate.getHours() === 14 || currentDate.getHours() === 22);
            assert.strictEqual(result, y + b);
            callCount += 1;
            if (callCount === 2) {
                break;
            }
        }
    }

    /*** testing: preserveResult ***/
    const throttler2 = Bluebird.promisifyAll(scheduledThrottle.create({
        client: redisClient,
        key: TEST_KEY_NAME,
        timezone: timezoneStr,
        localChangeTimes: ['0400'],
        preserveResult: true
    }));
    yield throttler2.clearAsync();
    const c = {
        u: 1,
        v: '1'
    };
    let throttledFnAsync = Bluebird.promisify(throttler2.throttle(cb => cb(null, c)));
    assert.strictEqual(yield throttledFnAsync(), c);
    assert.deepEqual(yield throttledFnAsync(), c);

    /*** testing: throttling a function that throws errors ***/
    yield throttler2.clearAsync();
    throttledFnAsync = Bluebird.promisify(throttler2.throttle(cb => cb(new Error('intentional'))));
    try {
        yield throttledFnAsync();
    } catch (err) {
        assert.strictEqual(err.message, 'intentional');
        try {
            yield throttledFnAsync(); // should throw again
        } catch (err) {
            assert.strictEqual(err.message, 'intentional');
        }
    }

    console.log('Success');
    redisClient.end();
})();