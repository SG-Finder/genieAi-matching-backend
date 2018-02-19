const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io').listen(server);
const moment =  require('moment');
const mysql = require('mysql');
const redis = require('redis');
const baseConvert = require('bases');
const matchingSpace = io.of('/matching');
const sessionManage = require('./redis_dao/session');
const port = process.env.PORT || 3000;
const waitMatchingKey = {
    NumOfPlayerTwo : 'waitMatching2',
    NumOfPlayerThree : 'waitMatching3',
    NumOfPlayerFour : 'waitMatching4',
    NumofPlayerFive : 'waitMatching5'

};

//db connection pool
const dbConnectionPool = mysql.createPool(require('./db-configs/mysql-config'));

let player = {};

// pub-sub channel
const gameLobbyA = 'lobby_a';

// Status machine
const subscribeMessageType = {
    CHAT_MESSAGE: 1,
    ENTRY_MESSAGE: 2,
    LEAVE_MESSAGE: 3,
    MATCHING_SUCCESS_MESSAGE: 4
};

let statusMessageMachine = 0;
const redisConfig = require('./db-configs/redis-config');
const redisClient = redis.createClient(redisConfig.port, redisConfig.host);
redisClient.auth(redisConfig.password);

// Subscribe lobby_a channel
const subscriber = redis.createClient(redisConfig.port, redisConfig.host);
subscriber.auth(redisConfig.password);
subscriber.subscribe(gameLobbyA);

// router
app.get('/', function (req, res) {
    res.sendFile(__dirname + '/index.html');
});

// Socket connection
matchingSpace.on('connection', function (socket) {
    console.log("someone connects this server : " + socket.id);
    console.log("socket ID conver to base 10 : " + Math.trunc(baseConvert.fromBase64(socket.id.split('#')[1]) / Math.pow(10, 30)));
    socket.on('ack', function (data) {
        console.log(data);
        //TODO BAD REQUEST EXCEPTION
        let key = "session:" + data.session_token;
        sessionManage.isValidSession(redisClient, key, function (isValidSession) {
            if (isValidSession) {
                sessionManage.findSessionData(redisClient, key, function (value) {
                    let newSession = JSON.parse(value);
                    newSession.last_updated_at = moment().format("YYYY-MM-DDThh:mm:ss");
                    sessionManage.updateSession(redisClient, key, JSON.stringify(newSession));
                    socket.emit('authorized', {
                        permit : true,
                        afterEvent : "none"
                    });

                    let selectQuery = "SELECT players.id, players.nickname, players.point, players.score, players.tier, weapons.name " +
                        "FROM players, weapon_relation, weapons " +
                        "WHERE players.id=weapon_relation.player_id and weapon_relation.weapon_id=weapons.id and players.nickname='" + data.nickname + "'";

                    //TODO error when can't bring data
                    dbConnectionPool.getConnection(function (err, connection) {
                        try {
                            console.log('success db connect');
                            connection.query(selectQuery, function (err, result) {
                                try {
                                    console.log(result[0]);
                                    let weapon = [];
                                    for (let i = 0; i < result.length; i++) {
                                        weapon[weapon.length] = result[i].name;
                                    }
                                    delete result[0].name;
                                    player[socket.id] = result[0];
                                    player[socket.id].weapon = weapon;
                                    player[socket.id].socket_id = socket.id;
                                    player[socket.id].matchingActivate = false;
                                    player[socket.id].roomKey = Math.trunc(baseConvert.fromBase64(socket.id.split('#')[1]) / Math.pow(10, 30));

                                    console.log(player[socket.id]);

                                    socket.emit('getData', {
                                        dataAccess : true,
                                        afterEvent : "ready"
                                    });
                                }
                                catch(err) {
                                    //TODO docs에 남기기
                                    socket.emit('getData', {
                                        dataAccess : false,
                                        message: "Not found player, please check your nickname",
                                        afterEvent : "resend `ack` event"
                                    });
                                    console.error(err);
                                }
                                finally {
                                    //connection 반환
                                    connection.release();
                                }
                            });
                        }
                        catch(err) {
                            connection.destroy();
                            console.error(err);
                        }

                    });
                });
            }
            else {
                socket.emit('authorized', {
                    permit : false,
                    message : "Expired your session token",
                    afterEvent : "disconnect"
                });
                socket.disconnect();
            }
        });

    });

    socket.on('ready', function () {
        //TODO delete event it is just testing event
        if (player[socket.id] == null) {
            socket.emit('retryReady', { error: "connection DB is fail"});
            return;
        }
        //로비서버는 다른 공간에 있을 수 있음
        socket.join(gameLobbyA, function () {
            statusMessageMachine = subscribeMessageType.ENTRY_MESSAGE;
            redisClient.publish(gameLobbyA, JSON.stringify({
                user: player[socket.id].nickname,
                userScore: player[socket.id].score,
                userTier: player[socket.id].tier
            }));
        });
    });

    socket.on('gameStart', function (data) {
        //TODO modulation && 동시에 접속했을 때의 이슈 && 매칭이 실패했을 때의 이슈 && 사용자의 수락 이벤트 핸들러
        //TODO 매칭 결과 데이터에 중복된 플레이어가 있을 경우의 이슈 처리(나 자신과의 싸움)
        if (player[socket.id].matchingActivate !== true) {
            let MATCHING_QUE;
            player[socket.id].matchingActivate = true;
            player[socket.id].wantsNumOfplayer = data.numOfPlayer;
            switch (data.numOfPlayer) {
                case 2:
                    MATCHING_QUE = waitMatchingKey.NumOfPlayerTwo;
                    break;
                case 3:
                    MATCHING_QUE = waitMatchingKey.NumOfPlayerThree;
                    break;
                case 4:
                    MATCHING_QUE = waitMatchingKey.NumOfPlayerFour;
                    break;
                case 5:
                    MATCHING_QUE = waitMatchingKey.NumofPlayerFive;
                    break;
                default:
                    socket.emit('matchingError', {
                        code: 400,
                        message: "Invalid parameter or limit avaliable player"
                    });
                    return;
            }
            player[socket.id].matchingQue = MATCHING_QUE;

            redisClient.smembers(MATCHING_QUE, function (err, list) {
                try {
                    if (list.length < data.numOfPlayer - 1) {
                        redisClient.sadd(MATCHING_QUE, JSON.stringify(player[socket.id]));
                        socket.emit('waitMatching', {
                            success: true
                        })
                    }
                    else if (list.length === (data.numOfPlayer - 1)) {
                        let matchingPlayer = [];
                        matchingPlayer[matchingPlayer.length] = player[socket.id];
                        for (let i = 0; i < (data.numOfPlayer - 1); i++) {
                            matchingPlayer[matchingPlayer.length] = JSON.parse(list.pop());
                            redisClient.srem(MATCHING_QUE, JSON.stringify(matchingPlayer[i]));
                        }

                        let saveRedisMatchingData = {
                            playersInfo: matchingPlayer,
                            roomId: player[socket.id].roomKey
                        };
                        statusMessageMachine = subscribeMessageType.MATCHING_SUCCESS_MESSAGE;
                        redisClient.publish(gameLobbyA, JSON.stringify(saveRedisMatchingData));
                    }
                }
                catch(err) {
                    console.log(err);
                    socket.emit('waitMatching', {
                        success: false
                    });
                }
            });
        }
    });

    socket.on('cancelMatching', function (data) {
        if (player[socket.id].matchingActivate === true) {
            redisClient.srem(player[socket.id].matchingQue, JSON.stringify(player[socket.id]), function (err, result) {
                try {
                    console.log(result);
                    player[socket.id].matchingActivate = false;
                    socket.emit('cancelMatchingResult', {
                        success: true
                    });
                }
                catch(err) {
                    console.log(err);
                    socket.emit('cancelMatchingResult', {
                        success: false
                    });
                }
            });
        }
    });

    socket.on('sendMessage', function (msg) {
        console.log(msg);
        statusMessageMachine = subscribeMessageType.CHAT_MESSAGE;
        redisClient.publish(gameLobbyA, JSON.stringify({
            from: player[socket.id].nickname,
            message: msg.message
        }));
    });

    socket.on('disconnect', function (reason) {
        console.log('somenoe disconnect this server');
        if (player[socket.id] !== undefined ) {
            socket.leave(gameLobbyA, function () {
                console.log(player);
                //Redis Matching Set에서 삭제
                if (player[socket.id].matchingActivate === true) {
                    redisClient.srem(player[socket.id].matchingQue, JSON.stringify(player[socket.id]), function (err, result) {
                        try {
                            console.log(result);
                        }
                        catch(err) {
                            console.log(err);
                        }
                    });
                }
                statusMessageMachine = subscribeMessageType.LEAVE_MESSAGE;
                redisClient.publish(gameLobbyA, JSON.stringify({
                    user: player[socket.id].nickname,
                    userScore: player[socket.id].score,
                    userTier: player[socket.id].tier
                }));
                delete player[socket.id];
            });
        }
    });
});

subscriber.on('message', function (channel, message) {
    console.log("Message '" + message + "' on channel '" + channel + "' arrived!");
    switch (statusMessageMachine) {
        case subscribeMessageType.CHAT_MESSAGE:
            matchingSpace.to(gameLobbyA).emit('receiveMessage', JSON.parse(message));
            break;
        case subscribeMessageType.ENTRY_MESSAGE:
            matchingSpace.to(gameLobbyA).emit('entry', JSON.parse(message));
            break;
        case subscribeMessageType.LEAVE_MESSAGE:
            matchingSpace.to(gameLobbyA).emit('leave', JSON.parse(message));
            break;
        case subscribeMessageType.MATCHING_SUCCESS_MESSAGE:
            let matchingData = JSON.parse(message);
            let players = [];
            for (let i = 0; i < matchingData.playersInfo.length; i++) {
                players[players.length] = matchingData.playersInfo[i].nickname;
            }
            for (let i = 0; i < matchingData.playersInfo.length; i++) {
                matchingSpace.to(matchingData.playersInfo[i].socket_id).emit('matchingResult', {
                    playersId: players,
                    roomId: matchingData.roomId,
                    numOfPlayer: (players.length + 1)
                });
                delete matchingData.playersInfo[i].matchingActivate;
                delete matchingData.playersInfo[i].socket_id;
                delete matchingData.playersInfo[i].matchingQue;
                delete matchingData.playersInfo[i].wantsNumOfplayer;
                delete matchingData.playersInfo[i].roomKey;
            }
            console.log(matchingData);
            redisClient.HMSET("roomId", matchingData.roomId, JSON.stringify(matchingData));
            break;
        default:
            break;
    }
});

server.listen(port, function () {
    console.log('matching server listening on port :' + port);
});