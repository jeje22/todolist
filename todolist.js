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
    res.locals.redis.lrange("todo:"+req.session.user,0,-1, function(err, reply){ // i.e. LRANGE todo:20 0 -1
        var promises=reply.map(function(elem){
            
            return new Promise(function(resolve, reject){
                res.locals.redis.get("todo:"+req.session.user+":"+elem, function(err, reply1){
                    var current=JSON.parse(reply1);
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
        var promises=[
            new Promise(function(resolve, reject){
                res.locals.redis.set("todo:"+req.session.user+":"+num,JSON.stringify(todo),function(err, reply1){ // i.e. SET todo:20:0 {"name":"Derp","date":"18/09/2017","priority":3}
                    resolve();
                });
            }),
            new Promise(function(resolve, reject){
                res.locals.redis.rpush("todo:"+req.session.user, num, function(err, reply2){  // i.e. RPUSH todo:20 0
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
        res.locals.redis.del("todo:"+req.session.user+":"+id,function(err,reply){
            resolve();
        });
    }));
    promises.push(new Promise(function(resolve, reject){
        res.locals.redis.lrem("todo:"+req.session.user,0,id, function(err,reply){
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
    var new_todo={"name":req.body.new_name,"date":req.body.new_date,"priority":req.body.new_priority};

    res.locals.redis.set("todo:"+req.session.user+":"+id,JSON.stringify(new_todo), function(err,reply){
        req.app.socket.broadcast.emit('change',{id: id, todo: new_todo});
        res.locals.redis.quit();
        res.redirect('/');
    });
})
.get('/up/:id',function(req,res){
    var id=req.params.id;

    /*res.locals.redis.lindex("todo:"+req.session.user, id+1, function(err, reply){
        if(reply!=null)
        {
            //res.locals.redis.lset("todo:"+req.session.user, id+1,);
        }
    });*/
    res.locals.redis.quit();
    res.redirect('/');
})
.get('/down/:id',function(req,res){
    var id=req.params.id;
    res.locals.redis.quit();
    res.redirect('/');
})
.get('/list/:uuid', function(req,res){
    req.session.user=ent.encode(req.params.uuid);
    res.redirect('/');
})
.get('/export', function(req,res){
    res.csv([req.session.todo]);
});

server.listen(8080);