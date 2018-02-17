exports.isValidSession = function (redisClient, key, fn) {
    console.log("key value : " +  key);
    redisClient.get(key, function (err, data) {
        try {
            if( data !== null ) {
                fn (true);
            }
            else {
                fn (false);
            }
        }
        catch(err) {
            console.log(err + ": isValidSession function err");
            fn(false);
        }
    });
};

exports.findSessionData = function(redisClient, key, fn) {
    redisClient.get(key, function (err, data) {
        try {
            fn(data);
        }
        catch(err) {
            console.log(err + ": findSessionData function err");
        }
    });
};

exports.updateSession = function (redisClient, key, value) {
    redisClient.set(key, value, function (err, data) {
        try {
            redisClient.expire(key, 3600);
        }
        catch(err) {
            console.log(err + ": updateSession function err");
        }
    })
};