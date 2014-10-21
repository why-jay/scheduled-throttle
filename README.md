#Scheduled Throttle

A throttled function will only execute once until it passes a certain time of day (backed by Redis).

##Install

```
npm install scheduled-throttle
```

##Example

```JavaScript
var REDIS_KEYS_EXPIRE = 1000000;

var scheduledThrottle = require('scheduled-throttle');

var throttler = scheduledThrottle.create({
    client: redisClient, // required
    key: 'foo:1', // required - Redis key name
    timezone: '+0900', // required
    localChangeTimes: [ // required
        '0400',
        '1430'
    ],
    inactivityExpire: REDIS_KEYS_EXPIRE // optional - in seconds - if not set, the relevant Redis keys never expire
}));

var obj = {
    a: 2,
    throttledFn: throttler.throttle(function (x, cb) { // callback should be a nodeback
        console.log('executed');
        cb(null, x + this.a);
    })
};

throttler.clear(function (err, result) { // "clear" method clears out all relevant Redis keys
    if (err) throw err;
     
    obj.throttledFn(1, function (err, result) {
        if (err) throw err;
        
        // prints 'executed'
        
        assert.strictEqual(result, 1 + 2);
    
        throttler.willExecute(function (err, result) {
            if (err) throw err;
            
            // will not execute until either 04:00 or 14:30 (local time)
            // also, after REDIS_KEYS_EXPIRE seconds,
            // relevant Redis keys will be cleared out, as if throttler.clear() is called
            assert.strictEqual(result, false);
            
            obj.throttledFn(1, function (err, result) {
                assert.strictEqual(result, scheduledThrottle.THROTTLED); // status code THROTTLED
            });
        });
    }); 
});

var throttlerWithPreserveResult = Bluebird.promisifyAll(scheduledThrottle.create({
    client: redisClient,
    key: TEST_KEY_NAME + '2',
    timezone: '+0900',
    localChangeTimes: ['0400'],
    preserveResult: true, // NOTICE THIS OPITON! - returns previous call result instead of THROTTLED
    serialize: function (result) { // optional
        // If not set, a default serializer is used (which is basically a JSON.stringify() that can handle undefined)
        // Redis can only store strings, so everything needs to be converted to and from a string.
        return JSON.stringify(result);
    },
    deserialize: function (str) { // optional - similar to the "serialize" option above
        // If not set, a default deserializer is used (which is basically a JSON.parse() that can handle undefined)
        return JSON.parse(str);
    }
}));

var c = {u: 1, v: '1'};
var throttledFnWithPreserveResult = throttlerWithPreserveResult.throttle(function (cb) { cb(null, c); });
throttledFnWithPreserveResult(function (err, result) {
    if (err) throw err;
    
    assert.strictEqual(result, c);
    
    throttledFnWithPreserveResult(function (err, result) {
        assert.deepEqual(result, c); // previous result has been kept along and is returned
        assert.notStrictEqual(result, scheduledThrottle.THROTTLED); // instead of THROTTLED being returned
    });
});
```

##Pretending a Time of Day

For testing purposes, you may want to pretend it's a certain time of day right now. In such cases, simply pass a `Date`
object as the second argument of the `.throttle` method:

```JavaScript
var throttler = scheduledThrottle.create({
    (other options...),
    timezone: '+0900',
    localChangeTimes: ['0400']
}));

var simulatedThrottledFn = throttler.throttle(function () {
    // will simulate as if it is 04:01 right now
}, new Date('2013-03-01T04:01:00+0900'));
```

##Test

Test is written in ES6, so Regenerator, 6to5 and Bash are being used for transpilation.

```
npm install
npm test
```
