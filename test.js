'use strict';

const TEST_KEY_NAME = 'schthrot_test:10';

const ScheduledThrottle = require('./main');

const _ = require('lodash');
const Bluebird = require('bluebird');
const assert = require('assert');
const redisClient = require('redis').createClient();

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

const throttler = Bluebird.promisifyAll(ScheduledThrottle.create({
    client: redisClient,
    key: TEST_KEY_NAME,
    timezone: timezoneStr,
    localChangeTimes: [
        '0400',
        '1400',
        '2200',
        pad(startHour, 2) + pad(startMin + 1, 2),
        pad(startHour, 2) + pad(startMin + 2, 2)
    ]
}));

const obj = {
    a: 10,
    throttledFnAsync: Bluebird.promisify(
        throttler.throttle(function (x) {
            return x + this.a;
        })
    )
};

const x = 1;
const y = 10;
const b = 10;

Bluebird.coroutine(function* () {
    yield throttler.clearAsync();

    process.stdout.write('.');
    assert.strictEqual(yield obj.throttledFnAsync(x), x + obj.a);

    let currentDate = new Date(startDate);
    for (let minuteHitCount = 0; true; currentDate.setSeconds(currentDate.getSeconds() + 1)) {
        process.stdout.write('.');

        let simulatedThrottledFn = throttler.throttle(function (y) {
            return y + this.b;
        }.bind({b}), currentDate);

        let result = yield Bluebird.promisify(simulatedThrottledFn)(y);

        if (result === ScheduledThrottle.THROTTLED) {
            assert.strictEqual((startDate.getMinutes() + minuteHitCount) % 60, currentDate.getMinutes());
        } else {
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

        let simulatedThrottledFn = throttler.throttle(Bluebird.method(() => y + b)(), currentDate);

        let result = yield Bluebird.promisify(simulatedThrottledFn)(y);

        if (result === ScheduledThrottle.THROTTLED) {
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

    console.log('Success');
    redisClient.end();
})();