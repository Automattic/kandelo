'use strict';
// Candidate Agent/client source over actual native Node TCP/stream/async/parser
// owners. This does not execute candidate production SpiderMonkey JSAPI.
const assert = require('node:assert/strict');
const native = require('node:http');
const { once } = require('node:events');
const { http: candidate } = require('./node-http-incoming-platform.cjs').create();
assert.equal(process.version, 'v26.13.0');
function shape(api) {
  const rows = [];
  for (const options of [{}, {keepAlive:true,maxSockets:2,maxTotalSockets:3,scheduling:'fifo'},
    {host:'x',port:80,localAddress:'127.0.0.1',family:4}, {socketPath:'/tmp/socket',family:6}]) {
    const agent = new api.Agent(options);
    rows.push({name:agent.getName(options),keepAlive:agent.keepAlive,maxSockets:String(agent.maxSockets),
      maxFreeSockets:agent.maxFreeSockets,maxTotalSockets:String(agent.maxTotalSockets),scheduling:agent.scheduling});
    agent.destroy();
  }
  for (const options of [{scheduling:'random'},{maxTotalSockets:0},{agentKeepAliveTimeoutBuffer:-1}]) {
    try { new api.Agent(options); rows.push('accepted'); }
    catch (error) { rows.push({code:error.code,message:error.message}); }
  }
  return rows;
}
async function request(api, port, agent, route='/') {
  const req = api.get({host:'127.0.0.1',port,path:route,agent});
  const result = new Promise((resolve,reject) => {
    req.on('error',reject);req.on('response',res => {
      const data=[];res.on('data',part=>data.push(part));res.on('error',reject);
      res.on('end',()=>resolve(Buffer.concat(data).toString()));
    });
  });
  const closed=once(req,'close');
  return {req, result, closed};
}
async function transport(api) {
  let connections=0; const sockets=new Set();
  const server=native.createServer((req,res)=>{
    res.setHeader('Content-Length',String(req.url.length));res.end(req.url);
  });
  server.on('connection',socket=>{connections++;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  const agent=new api.Agent({keepAlive:true,maxSockets:1,maxTotalSockets:1,maxFreeSockets:1});
  const deadline=setTimeout(()=>{for(const socket of sockets)socket.destroy();},5000);deadline.unref();
  try {
    const rows=[];
    for(const route of ['/one','/two']) {
      const op=await request(api,port,agent,route);const body=await op.result;await op.closed;
      rows.push({body,reused:op.req.reusedSocket,finished:op.req.writableFinished});
    }
    const operations=await Promise.all(['/three','/four','/five'].map(route=>request(api,port,agent,route)));
    for(const op of operations){rows.push({body:await op.result});await op.closed;}
    assert.equal(connections,1);
    assert.equal(Object.values(agent.requests).flat().length,0);
    assert.equal(Object.values(agent.freeSockets).flat().length,1);
    agent.destroy();
    return {rows,connections};
  } finally {clearTimeout(deadline);agent.destroy();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
}
async function queuedCancellation(api) {
  const { AsyncLocalStorage }=require('node:async_hooks');
  const als=new AsyncLocalStorage(); const peers=new Set(); const wire=[]; let release,started;
  const arrived=new Promise(resolve=>started=resolve);
  const server=native.createServer((req,res)=>{
    wire.push(req.url);
    if(req.url==='/held'){release=()=>res.end('held');started();}
    else res.end(req.url);
  });
  server.on('connection',socket=>{peers.add(socket);socket.on('close',()=>peers.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port,agent=new api.Agent({keepAlive:true,maxSockets:1});
  const error=new Error('cancel queued request'),events=[];
  const deadline=setTimeout(()=>{for(const peer of peers)peer.destroy();},5000);deadline.unref();
  try {
    const first=await request(api,port,agent,'/held');await arrived;
    let canceled;
    als.run('cancel',()=>{canceled=api.get({host:'127.0.0.1',port,path:'/cancel',agent});});
    canceled.on('error',value=>{assert.equal(value,error);events.push(['cancel-error',als.getStore()]);});
    const canceledClose=new Promise(resolve=>canceled.once('close',()=>{events.push(['cancel-close',als.getStore()]);resolve();}));
    canceled.destroy(error);
    let last;
    als.run('last',()=>{
      last=api.get({host:'127.0.0.1',port,path:'/last',agent});
      last.once('socket',()=>events.push(['last-socket',als.getStore()]));
    });
    const lastResult=new Promise((resolve,reject)=>{last.once('error',reject);last.once('response',res=>{
      const data=[];res.on('data',part=>data.push(part));res.once('error',reject);
      res.once('end',()=>{events.push(['last-end',als.getStore()]);resolve(Buffer.concat(data).toString());});
    });});
    const lastClose=once(last,'close');release();
    assert.equal(await first.result,'held');await first.closed;await canceledClose;
    assert.equal(await lastResult,'/last');await lastClose;
    assert.deepEqual(wire,['/held','/last']);
    return {events,wire};
  }finally{clearTimeout(deadline);agent.destroy();for(const peer of peers)peer.destroy();await new Promise(resolve=>server.close(resolve));}
}
async function agentSelection(api) {
  const peers=new Set();let connections=0;
  const server=native.createServer((_req,res)=>res.end('ok'));
  server.on('connection',socket=>{connections++;peers.add(socket);socket.on('close',()=>peers.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port,original=api.globalAgent;
  const replacement=new api.Agent({keepAlive:true,maxSockets:1});
  const deadline=setTimeout(()=>{for(const peer of peers)peer.destroy();},5000);deadline.unref();
  try {
    api.globalAgent=replacement;
    for(let i=0;i<2;i++){const op=await request(api,port,undefined);assert.equal(op.req.agent,replacement);await op.result;await op.closed;}
    const afterDefault=connections;
    for(let i=0;i<2;i++){const op=await request(api,port,false);assert.notEqual(op.req.agent,replacement);assert.equal(op.req.agent.keepAlive,false);await op.result;await op.closed;}
    let called=0,observed;
    const req=api.get({host:'127.0.0.1',port,customOption:'retained',createConnection(options){
      called++;observed={port:options.port,host:options.host,customOption:options.customOption};
      return require('node:net').connect(options);
    }});
    const done=new Promise((resolve,reject)=>{req.once('error',reject);req.once('response',res=>{res.resume();res.once('end',resolve);});});
    const closed=once(req,'close');await done;await closed;assert.equal(req.agent,undefined);
    const descriptor=Object.getOwnPropertyDescriptor(api,'globalAgent');
    return {afterDefault,connections,called,observed:{...observed,port:'ephemeral'},
      descriptor:{enumerable:descriptor.enumerable,configurable:descriptor.configurable,get:[descriptor.get.name,descriptor.get.length],set:[descriptor.set.name,descriptor.set.length]}};
  }finally{api.globalAgent=original;clearTimeout(deadline);replacement.destroy();for(const peer of peers)peer.destroy();await new Promise(resolve=>server.close(resolve));}
}
async function idlePoison(api) {
  let connections=0;const peers=new Set();let peer;
  const server=native.createServer((req,res)=>res.end(String(req.socket.id)));
  server.on('connection',socket=>{socket.id=++connections;peer=socket;peers.add(socket);socket.on('close',()=>peers.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const agent=new api.Agent({keepAlive:true,maxSockets:1}),port=server.address().port;
  const deadline=setTimeout(()=>{for(const socket of peers)socket.destroy();},5000);deadline.unref();
  try{
    const first=await request(api,port,agent);assert.equal(await first.result,'1');await first.closed;
    await new Promise((resolve,reject)=>peer.write('HTTP/1.1 299 Poison\r\nContent-Length: 6\r\n\r\npoison',error=>error?reject(error):resolve()));
    const second=await request(api,port,agent);const body=await second.result;await second.closed;
    assert.equal(body,'2');assert.equal(connections,2);return {body,connections,reused:second.req.reusedSocket};
  }finally{clearTimeout(deadline);agent.destroy();for(const socket of peers)socket.destroy();await new Promise(resolve=>server.close(resolve));}
}
async function proxy(api) {
  const peers=new Set();let seen;
  const server=native.createServer((req,res)=>{seen={path:req.url,host:req.headers.host,auth:req.headers['proxy-authorization'],connection:req.headers['proxy-connection']};res.end('proxied');});
  server.on('connection',socket=>{peers.add(socket);socket.on('close',()=>peers.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const agent=new api.Agent({keepAlive:true,proxyEnv:{http_proxy:'http://user:pass@127.0.0.1:'+server.address().port}});
  const deadline=setTimeout(()=>{for(const socket of peers)socket.destroy();},5000);deadline.unref();
  try{
    const req=api.get({host:'endpoint.invalid',port:80,path:'/real?query=1',agent});
    const done=new Promise((resolve,reject)=>{req.once('error',reject);req.once('response',res=>{const chunks=[];res.on('data',part=>chunks.push(part));res.once('end',()=>resolve(Buffer.concat(chunks).toString()));});});
    const closed=once(req,'close');assert.equal(await done,'proxied');await closed;
    let invalid;try{api.request({host:'endpoint.invalid',agent,headers:{Host:'foreign.invalid'}});}catch(error){invalid={code:error.code,message:error.message};}
    assert.equal(invalid.code,'ERR_INVALID_ARG_VALUE');return {seen,invalid};
  }finally{clearTimeout(deadline);agent.destroy();for(const socket of peers)socket.destroy();await new Promise(resolve=>server.close(resolve));}
}
(async()=>{
  assert.deepEqual(shape(candidate),shape(native));
  const actual=await transport(candidate),expected=await transport(native);
  assert.deepEqual(actual,expected);
  const canceled=await queuedCancellation(candidate);assert.deepEqual(canceled,await queuedCancellation(native));
  const selected=await agentSelection(candidate);assert.deepEqual(selected,await agentSelection(native));
  const poisoned=await idlePoison(candidate);assert.deepEqual(poisoned,await idlePoison(native));
  const proxied=await proxy(candidate);assert.deepEqual(proxied,await proxy(native));
  console.log(JSON.stringify({passed:true,shapeCases:7,realTcpRequests:30,observed:actual,queuedCancellation:canceled,agentSelection:selected,idlePoison:poisoned,plainHttpProxy:proxied,
    boundary:'candidate HTTP Agent/client algorithms; native TCP/stream/async/parser dependencies; production JSAPI unrun'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
