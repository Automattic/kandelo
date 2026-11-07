'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),native=require('node:http'),{once}=require('node:events');
assert.equal(process.version,'v26.13.0');
const root=path.resolve(process.argv[2]||path.join(__dirname,'../../..'));const candidate=require(path.join(root,'host/test/fixtures/node-http-incoming-platform.cjs')).create().http;
async function observe(api,mode){
 const peers=new Set(),server=native.createServer((req,res)=>{res.setHeader('Content-Length','0');if(mode==='response-close')res.setHeader('Connection','close');res.end()});server.on('connection',p=>{peers.add(p);p.on('close',()=>peers.delete(p))});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const agent=new api.Agent({keepAlive:mode!=='agent-no-keepalive',timeout:3210});let socket;const calls=[];
 try{
  const req=api.get({host:'127.0.0.1',port:server.address().port,agent});const closed=once(req,'close');req.on('socket',s=>{socket=s;const real=s.setTimeout;s.setTimeout=function(delay,cb){calls.push({delay,callback:cb===req.timeoutCb});return Reflect.apply(real,this,arguments)}});
  const[res]=await once(req,'response');const ended=once(res,'end');res.resume();await ended;await closed;
  return {mode,calls,shouldKeepAlive:req.shouldKeepAlive,timeoutCbCleared:req.timeoutCb===null};
 }finally{agent.destroy();for(const peer of peers)peer.destroy();socket?.destroy();await new Promise(resolve=>server.close(resolve))}
}
(async()=>{const rows=[];for(const mode of ['agent-no-keepalive','response-close','keepalive'])rows.push({native:await observe(native,mode),candidate:await observe(candidate,mode)});console.log(JSON.stringify({scope:'Exact candidate HTTP client/Agent source over real native TCP/stream/parser/async dependencies; actual socket.setTimeout forwards to real method, no timers simulated; not guest JSAPI',rows}));for(const row of rows)assert.deepEqual(row.candidate,row.native)})().catch(e=>{console.error(e);process.exitCode=1});
