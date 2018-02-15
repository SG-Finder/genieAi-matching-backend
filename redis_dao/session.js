exports.isValidSession = function (redisClient, key, fn) {
    console.log("key value : " +  key);
    redisClient.get(key, function (err, data) {
        if (err) {
            console.log(err + ": isValidSession function err");
            return;
        }

        if( data !== null ) {
            fn (true);
        }
        else {
            fn (false);
        }
    });
};

exports.findSessionData = function(redisClient, key, fn) {
    redisClient.get(key, function (err, data) {
        if (err) {
            console.log(err + ": findSessionData function err");
            return;
        }
        fn(data);
    })
};

exports.updateSession = function (redisClient, key, value) {
    redisClient.set(key, value, function (err, data) {
        if (err) {
            console.log(err + ": updateSession function err");
        }
        else {
            redisClient.expire(key, 3600);
        }
    })
};