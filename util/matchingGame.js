exports.saveMatchingResultRedis = function(redisClient, playerA, playerB, roomId) {
    let inputData = {
        players: [ playerA, playerB ]
    };
    redisClient.hset("roomId", roomId, JSON.stringify(inputData), redisClient.print);
};