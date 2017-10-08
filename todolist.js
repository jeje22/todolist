var app=require('express')();
var session = require('express-session');
var csv = require('express-csv');
var morgan = require('morgan'); // Charge le middleware de logging
const uuidv1 = require('uuid/v1');
var redis = require("redis");
var bodyParser = require('body-parser');
var server=require('http').createServer(app);
var io=require('socket.io').listen(server);
var ent = require('ent');

app.use(session({ secret: 'keyboard cat', resave: true, saveUninitialized: false }));

app.use(bodyParser.json());   // to support JSON-encoded bodies
app.use(bodyParser.urlencoded({  // to support URL-encoded bodies
  extended: true
}));

io.sockets.on('connection', function(socket){
    app.socket=socket;
});

app.use(morgan('combined'))
.use(function(req,res,next){

    var client=redis.createClient();
    client.on("error", function (err) {
        console.log("Error " + err);
    });

    if(typeof req.session.user === 'undefined')
    {
        req.session.user=20;
        //client.set("todos:user:"+req.session.user,0) // i.e. SET todos:user:20 0
    }
    res.locals.redis=client;

    next();
})
.get('/', function(req, res){
    var todos=[];
    res.locals.redis.sort("todo:"+req.session.user,"by","todo:"+req.session.user+":*->order", function(err, reply){ // i.e. SORT todo:20 by todo:20:*->order
        var promises=reply.map(function(elem){
            
            return new Promise(function(resolve, reject){
                res.locals.redis.hmget("todo:"+req.session.user+":"+elem,"name","date","priority","order", function(err, reply1){ // i.e. HMGET todo:20:0 name date priority order
                    var current={"name": reply1[0], "date":reply1[1],"priority":reply1[2],"order":reply1[3]};
                    current.id=elem;
                    todos.push(current);
                    resolve();
                });
            });
        });

        Promise.all(promises)
        .then(function(){
            res.locals.redis.quit();
            res.render('todolist.ejs', {todo: todos});
        })
        .catch(function(reason){
            console.log(reason);
        });
    });
})
.post('/add', function(req,res){
    var todo={"name":req.body.name,"date":req.body.date,"priority":req.body.priority};

    res.locals.redis.incr("todos:user:"+req.session.user, function(err,reply){ // getting max id with todos:user:20
        var num=reply-1;
        todo.order=num;
        var promises=[
            new Promise(function(resolve, reject){
                res.locals.redis.hmset("todo:"+req.session.user+":"+num,"name",todo.name,"date",todo.date,"priority",todo.priority,"order",todo.order, function(err, reply1){ // i.e. HMSET todo:20:0 "name" "Derp" "date" "18/09/2017" "priority" 3 order 0
                    resolve();
                });
            }),
            new Promise(function(resolve, reject){
                res.locals.redis.sadd("todo:"+req.session.user, num, function(err, reply1){  // i.e. SADD todo:20 0
                    resolve();
                });
            })
        ];
        Promise.all(promises)
        .then(function(){
            req.app.socket.broadcast.emit('new',todo);
            res.locals.redis.quit();
            res.redirect('/');
        })
        .catch(function(reason){
            console.log(reason);
        });
    });
})
.get('/delete/:id', function(req, res){
    var id=req.params.id;

    var promises=[];
    promises.push(new Promise(function(resolve, reject){
        res.locals.redis.del("todo:"+req.session.user+":"+id,function(err,reply){ // i.e. : DEL todo:20:0
            resolve();
        });
    }));
    promises.push(new Promise(function(resolve, reject){
        res.locals.redis.srem("todo:"+req.session.user,id, function(err,reply){ // i.e. : SREM todo:20 0
            resolve();
        });
    }));

    Promise.all(promises)
    .then(function(){
        req.app.socket.broadcast.emit('delete',id);
        res.locals.redis.quit();
        res.redirect('/');
    })
    .catch(function(reason){
        console.log(reason);
    });
})
.post('/change/:id', function(req,res){
    var id=req.params.id;
    var new_todo={"name":req.body.new_name,"date":req.body.new_date,"priority":req.body.new_priority,"order":id};

    res.locals.redis.hmset("todo:"+req.session.user+":"+id,"name",new_todo.name,"date",new_todo.date,"priority",new_todo.priority,"order",new_todo.order, function(err, reply1){
        req.app.socket.broadcast.emit('change', new_todo);
        res.locals.redis.quit();
        res.redirect('/');
    });
})
.get('/up/:id',function(req,res){
    var id=req.params.id;

    res.locals.redis.sort("todo:"+req.session.user,"by","todo:"+req.session.user+":*->order", function(err, reply){
        var index=reply.findIndex(function(elem){
            return elem==id;
        });
        if(index>0)
        {
            var id_previous=reply[index-1];
            res.locals.redis.hget("todo:"+req.session.user+":"+id_previous,"order", function(err, order_previous){
                res.locals.redis.hget("todo:"+req.session.user+":"+id,"order", function(err,order_next){
                    var promises=[
                        new Promise(function(resolve, reject){
                            res.locals.redis.hset("todo:"+req.session.user+":"+id,"order",order_previous, function(err,reply1){
                                resolve();
                            });
                        }),
                        new Promise(function(resolve, reject){
                            res.locals.redis.hset("todo:"+req.session.user+":"+id_previous,"order",order_next, function(err,reply1){
                                resolve();
                            });
                        })
                    ];
        
                    Promise.all(promises)
                    .then(function(){
                        req.app.socket.broadcast.emit('down',id);
                        res.locals.redis.quit();
                        res.redirect('/');
                    })
                    .catch(function(reason){
                        console.log(reason);
                    });
                });
            });
        }
        else
        {
            console.log("can't get higher than the first element");
            res.locals.redis.quit();
            res.redirect('/');
        }
    });
})
.get('/down/:id',function(req,res){
    var id=req.params.id;

    res.locals.redis.sort("todo:"+req.session.user,"by","todo:"+req.session.user+":*->order", function(err, reply){
        var index=reply.findIndex(function(elem){
            return elem==id;
        });
        if(index<reply.length-1 || index==-1)
        {
            var id_next=reply[index+1];
            res.locals.redis.hget("todo:"+req.session.user+":"+id_next,"order", function(err, order_next){
                res.locals.redis.hget("todo:"+req.session.user+":"+id,"order", function(err,order_previous){

                    var promises=[
                        new Promise(function(resolve, reject){
                            res.locals.redis.hset("todo:"+req.session.user+":"+id,"order",order_next, function(err,reply1){
                                resolve();
                            });
                        }),
                        new Promise(function(resolve, reject){
                            res.locals.redis.hset("todo:"+req.session.user+":"+id_next,"order",order_previous, function(err,reply1){
                                resolve();
                            });
                        })
                    ];
        
                    Promise.all(promises)
                    .then(function(){
                        req.app.socket.broadcast.emit('down',id);
                        res.locals.redis.quit();
                        res.redirect('/');
                    })
                    .catch(function(reason){
                        console.log(reason);
                    });
                });
            });
        }
        else
        {
            console.log("can't get lower than the last element");
            res.locals.redis.quit();
            res.redirect('/');
        }
    });
})
.get('/list/:uuid', function(req,res){
    req.session.user=ent.encode(req.params.uuid);
    res.redirect('/');
})
.get('/export', function(req,res){
    res.csv([req.session.todo]);
});

server.listen(8080);