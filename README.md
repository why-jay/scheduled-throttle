#Scheduled Throttle

A throttled function will only execute once until it passes a certain time of day (backed by Redis).

##Install

```
npm install scheduled-throttle
```

##Example

Check out the following example written in ES6. Hopefully you're familiar with coroutines/generators/Bluebird! :)

```JavaScript
var REDIS_KEYS_EXPIRE = 1000000;

var scheduledThrottle = require('scheduled-throttle');
var assert = require('assert');
var Bluebird = require('bluebird');

var throttler = scheduledThrottle.create({
    client: redisClient, // required
    key: 'foo:1', // required - Redis key name
    timezone: '+0900', // required
    localChangeTimes: [ // required
        '0400',
        '1430'
    ],
    inactivityExpire: REDIS_KEYS_EXPIRE, // optional - in seconds
                                 // if not set, the relevant Redis keys never expire
    serialize: function (numberResult) { // optional
        // If not set, a default serializer is used (which is basically a JSON.stringify()
        // that can handle undefined). Redis can only store strings, so everything needs
        // to be converted to and from a string.
        return String(numberResult);
    },
    deserialize: function (stringStored) { // optional - similar to the serialize
        // If not set, a default deserializer is used (which is basically a JSON.parse()
        // that can handle undefined)
        return JSON.parse(stringStored);
    }
}));
throttler = Bluebird.promisifyAll(throttler);

var obj = {
    a: 2,
    throttledFn: throttler.throttle(function (x, cb) { // callback should be a nodeback
        console.log('executed');
        cb(null, x + this.a);
    })
};
obj = Bluebird.promisifyAll(obj);

Bluebird.coroutine(function* () {
    yield throttler.clearAsync(); // "clear" method - clears out all relevant Redis keys
    
    var result = yield obj.throttledFnAsync(1);
    // 'executed' is printed because of console.log() above
    assert.strictEqual(result, 1 + 2);
    
    var will = yield throttler.willExecuteAsync();
    // will not execute until either 04:00 or 14:30 (local time)
    assert.strictEqual(result, false);
    // also, after REDIS_KEYS_EXPIRE seconds,
    // relevant Redis keys will be cleared out, as if throttler.clear() is called

    var result2 = yield obj.throttledFnAsync(1);
    assert.strictEqual(result2, scheduledThrottle.THROTTLED);     
})();
```

Now check out the "preserveResult" option:

```JavaScript
var throttler = Bluebird.promisifyAll(scheduledThrottle.create({
    client: redisClient,
    key: TEST_KEY_NAME,
    timezone: '+0900',
    localChangeTimes: ['0400'],
    preserveResult: true /*** NOTICE THIS OPTION! ***/
}));

var c = {u: 1, v: '1'};
var throttledFn = throttler.throttle(function (cb) { cb(null, c); });
var throttledFnAsync = Bluebird.promisify(throttledFn);

Bluebird.coroutine(function* () {
    var result = yield throttledFnAsync();
    assert.strictEqual(result, c);
    
    var result2 = yield throttledFnAsync();
    assert.deepEqual(result2, c); // previous result has been kept along and is returned
    assert.notStrictEqual(result2, scheduledThrottle.THROTTLED); // instead of THROTTLED
})();
```

##Error within the function being throttled

When there is an error (not necessarily an `Error` object) is thrown inside the function being throttled,
the throttler will stop the process immediately and no changes will occur with Redis.

```JavaScript
const throttledFnAsync = Bluebird.promisify(throttler2.throttle(cb => cb(new Error('intentional'))));
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
```

##Pretending a Time of Day

For testing purposes, you may want to pretend it's a certain time of day right now. In such cases, simply pass a `Date`
object as the first argument of `.throttle()` or `.willExecute()`:

```JavaScript
var throttler = scheduledThrottle.create({
    (other options...),
    timezone: '+0900',
    localChangeTimes: ['0400']
}));

var simulatedThrottledFn = throttler.throttle(new Date('2013-03-01T04:01:00+0900'), function (cb) {
    // will simulate as if it is 04:01 right now
});
```

##Test

Test is written in ES6, so 6to5 is used for transpilation.

```
npm install
npm test
```
