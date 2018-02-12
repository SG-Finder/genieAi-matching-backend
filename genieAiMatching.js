// Core module
const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io').listen(server);
const port = process.env.PORT || 3000;
const moment =  require('moment');
const matchingSpace = io.of('/matching');

//redis module

const redis = require('redis');
const redisClient = redis.createClient(6379, '192.168.0.60');
redisClient.auth('tmakdlfrpdlxm');
const waitMatchingKey = 'waitMatchingPlayer';

// DB module
const mysql = require('mysql');

//Todo make connection pool and then manage them
const connection = mysql.createConnection(require('./db/db_info'));
connection.connect(function (err) {
    try {
        console.log('connect mysql server');
    }
    catch (err) {
        console.log('connect error to mysql server');
    }
});

// Customizing module
const sessionManage = require('./redis_dao/session');

// Util
const game = require('./util/matchingGame');
let player = {};
let waitingPlayer = [];
const gameLobbyA = 'lobby_a';

// Status machine
const subscribeMessageType = {
    CHAT_MESSAGE: 1,
    ENTRY_MESSAGE: 2,
    LEAVE_MESSAGE: 3,
    MATCHING_SUCCESS_MESSAGE: 4
};

let statusMessageMachine = 0;

app.get('/', function (req, res) {
    res.sendFile(__dirname + '/index.html');
});
// Subscribe lobby_a channel
const subscriber = redis.createClient(6379, '192.168.0.60');
subscriber.auth('tmakdlfrpdlxm');
subscriber.subscribe(gameLobbyA);

subscriber.on('message', function (channel, message) {
    console.log("Message '" + message + "' on channel '" + channel + "' arrived!");
    switch (statusMessageMachine) {
        case subscribeMessageType.CHAT_MESSAGE:
            matchingSpace.to(gameLobbyA).emit('receiveMessage', message);
            break;
        case subscribeMessageType.ENTRY_MESSAGE:
            matchingSpace.to(gameLobbyA).emit('entry', message);
            break;
        case subscribeMessageType.LEAVE_MESSAGE:
            matchingSpace.to(gameLobbyA).emit('leave', message);
            break;
        case subscribeMessageType.MATCHING_SUCCESS_MESSAGE:
            let matchingData = JSON.parse(message);
            let playerA = matchingData.playerSocketId;
            let playerB = matchingData.opponentPlayerSocketId;
            delete matchingData.playerSocketId;
            delete matchingData.opponentPlayerSocketId;

            matchingSpace.to(playerA).emit('matchingResult', JSON.stringify(matchingData));
            matchingSpace.to(playerB).emit('matchingResult', JSON.stringify(matchingData));
            break;
        default :
            console.log("status machine error");
    }
});

// Socket connection
matchingSpace.on('connection', function (socket) {
    console.log("someone connects this server");

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

                    let selectQuery = "SELECT * FROM players WHERE nickname='" + data.nickname + "'";

                    //TODO error when can't bring data

                    connection.query(selectQuery, function (err, result, field) {
                        if (err) {
                            socket.emit('getData', {
                                dataAccess : false,
                                afterEvent : "disconnect"
                            });
                            console.log(err);
                            throw err;
                        }

                        player[socket.id] = result[0];
                        player[socket.id].socket_id = socket.id;
                        player[socket.id].matchingActivate = false;
                        //connection.end();
                        socket.emit('getData', {
                            dataAccess : true,
                            afterEvent : "ready"
                        });
                    });
                });
            }
            else {
                socket.emit('authorized', {
                    permit : false,
                    afterEvent : "disconnect"
                });
                socket.disconnect();
            }
        });

    });

    socket.on('ready', function (data) {
        //TODO delete event it is just testing event
        console.log(player[socket.id]);

        if (player[socket.id] == null) {
            socket.emit('retryReady', { error: "connection DB is fail"});
            return;
        }
        //로비서버는 다른 공간에 있을 수 있음
        socket.join(gameLobbyA, function () {
            statusMessageMachine = subscribeMessageType.ENTRY_MESSAGE;
            redisClient.publish(gameLobbyA, JSON.stringify({
                entryUser: player[socket.id].nickname,
                entryUserScore: player[socket.id].score,
                entryUserTier: player[socket.id].tier
            }));
        });
    });

    socket.on('gameStart', function () {
        //TODO modulation && 동시에 접속했을 때의 이슈 && 매칭이 실패했을 때의 이슈 && 사용자의 수락 이벤트 핸들러
        //TODO 매칭 결과 redis에 저장
        //TODO 클러스터링을 위해 매칭 대기 큐를 redis set 구조로 옮긴다
        //TODO 매칭 결과 데이터에 중복된 플레이어가 있을 경우의 이슈 처리(나 자신과의 싸움)
        player[socket.id].matchingActivate = true;
        redisClient.smembers(waitMatchingKey, function (err, list) {
            if (err) {
                socket.emit('waitMatching', {
                    success: false
                });
                throw err;
            }
            console.log(list);
            if (list.length === 0) {
                redisClient.sadd(waitMatchingKey, JSON.stringify({
                   playerNickname: player[socket.id].nickname,
                   playerSocketId: socket.id
                }));
                socket.emit('waitMatching', {
                    success: true
                })
            }
            else {
                let opponentPlayer = JSON.parse(list.pop());
                let matchingResultData = {
                    playersId: [opponentPlayer.playerNickname, player[socket.id].nickname],
                    playerSocketId: socket.id,
                    opponentPlayerSocketId: opponentPlayer.playerSocketId,
                    roomId: player[socket.id].id
                };
                redisClient.srem(waitMatchingKey, JSON.stringify(opponentPlayer));
                statusMessageMachine = subscribeMessageType.MATCHING_SUCCESS_MESSAGE;
                redisClient.publish(gameLobbyA, JSON.stringify(matchingResultData));
            }
        });
    });

    socket.on('cancelMatching', function (data) {
        if (player[socket.id].matchingActivate === true) {
            redisClient.srem(waitMatchingKey, JSON.stringify({
                playerNickname: player[socket.id].nickname,
                playerSocketId: socket.id
            }), function (err, result) {
                if (err) {
                    socket.emit('cancelMatchingResult', {
                        success: false
                    });
                    throw err;
                }
                socket.emit('cancelMatchingResult', {
                    success: true
                });
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
        //console.log(reason);
        console.log('somenoe disconnect this server');
        if (player[socket.id] !== undefined ) {
            socket.leave(gameLobbyA, function () {
                statusMessageMachine = subscribeMessageType.LEAVE_MESSAGE;
                redisClient.publish(gameLobbyA, player[socket.id].nickname);
                console.log(player);
                //SET에서 삭제
                if (player[socket.id].matchingActivate === true) {
                    redisClient.srem(waitMatchingKey, JSON.stringify({
                        playerNickname: player[socket.id].nickname,
                        playerSocketId: socket.id
                    }));
                }
                delete player[socket.id];
            });
        }
    });
});

server.listen(port, function () {
    console.log('matching server listening on port :' + port);
});