exports.matchingGame = function (waitingPlayer, player, TIER, matchingSpace, socket) {

};

exports.saveMatchingResultRedis = function(redisClient, playerA, playerB, roomId) {
    let inputData = {
        players: [ playerA, playerB ]
    };
    redisClient.hset("roomId", roomId, JSON.stringify(inputData), redisClient.print);
};

exports.isPresentGame = function (redisClient, matchingData) {

};

compareMatchingData = function (dataA, dataB) {
    //TODO 데이터 비교
    if (dataA === dataB) {
        return true;
    }
    else {
        return false;
    }
};

exports.generateRoomId = function () {
    return 1;
};