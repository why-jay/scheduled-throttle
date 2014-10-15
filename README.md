#Scheduled Throttle

Function will only execute once until it passes a certain time of day (backed by Redis).

#Install

```
npm install scheduled-throttle
```

#Example

```JavaScript
var ScheduledThrottle = require('scheduled-throttle');

var throttler = ScheduledThrottle.create({
    client: redisClient,
    key: 'foo:1',
    timezone: '+0900',
    localChangeTimes: [
        '0400',
        '1430'
    ]
}));

var obj = {
    a: 2,
    throttledFn: throttler.throttle(function (x) {
        console.log('executed');
    });
};

throttler.clear(function (err, result) { // "clear" method
    if (err) throw err;
     
    obj.throttledFn(1, function (err, result) {
        if (err) throw err;
        
        // 'executed'
        assert.strictEqual(result, 1 + 2);
    
        obj.throttledFn(1, function (err, result) {
            if (err) throw err;

            // will not execute until either 04:00 or 14:30 (local time)
            assert.strictEqual(result, ScheduledThrottle.THROTTLED); // status code THROTTLED
        });
    }); 
});

```

#Pretending a Time of Day

For testing purposes, you may want to pretend it's a certain time of day right now. In such cases, simply pass a `Date`
object as the second argument of the `.throttle` method:

```JavaScript
var throttler = ScheduledThrottle.create({
    [other options],
    timezone: '+0900',
    localChangeTimes: ['0400']
}));

var simulatedThrottledFn = throttler.throttle(function () {
    // will simulate as if it is 04:01 right now
}, new Date('2013-03-01T04:01:00+0900'));
```

#Test

Test is written in ES6, so Regenerator, 6to5 and Bash are being used for transpilation.

```
npm install
npm test
```
