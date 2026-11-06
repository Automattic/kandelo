'use strict';
// Actual candidate request/parser/OutgoingMessage sources through real native
// TCP and native HTTP peers. No fabricated socket/write completion or parser.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const candidate=require('./node-http-incoming-platform.cjs').create().http;
assert.equal(process.version,'v26.13.0');
const cases={
 endString:{run(req){req.end('hello');}},
 endBinary:{run(req){req.end(Buffer.from([0,255,128,1]));}},
 streamed:{run(req){req.write('one');req.write(Buffer.from([0,255]));req.end('last');}},
 empty:{run(req){req.end();}},
 fixed:{headers:{'Content-Length':5},run(req){req.end('hello');}},
 strict:{headers:{'Content-Length':5},run(req){req.strictContentLength=true;req.write('he');req.end('llo');}},
 trailers:{headers:{Trailer:'X-End'},run(req){req.write('hello');req.addTrailers({'X-End':['first','second']});req.end();}},
 corked:{run(req){req.cork();req.write('one');req.write('two');req.uncork();req.end();}},
 emptyChunks:{run(req){req.write('');req.write(Buffer.alloc(0));req.end('last');}},
 flush:{run(req){req.flushHeaders();req.end('hello');}},
 expect:{headers:{Expect:'100-continue'},run(req){req.once('continue',()=>req.end('hello'));}},
 utf8:{run(req){req.end('a😀é');}},
 callbacks:{run(req,events){req.write('one',()=>events.push('write-callback'));req.end('two',error=>events.push(error?error.code:'end-callback'));}},
};
async function compare(spec){
 const sockets=new Set();let peer;
 const server=http.createServer((request,response)=>{
  const body=[];request.on('data',b=>body.push(b));request.on('end',()=>{
   peer={rawHeaders:request.rawHeaders,body:Buffer.concat(body).toString('hex'),trailers:request.rawTrailers};
   response.setHeader('Connection','close');response.end('ok');
  });
 });
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 async function run(api){
  peer=undefined;const events=[];
  const request=api.request({host:'127.0.0.1',port:server.address().port,method:'POST',
   headers:{Connection:'close',...spec.headers}});
  const completed=new Promise((resolve,reject)=>{
   request.on('error',reject);request.on('finish',()=>events.push('finish'));
   request.on('response',response=>{events.push('response');const data=[];response.on('data',b=>data.push(b));
    response.on('error',reject);response.on('end',()=>{events.push('end');resolve(Buffer.concat(data).toString());});});
  });
  const closed=new Promise(resolve=>request.once('close',()=>{events.push('close');resolve();}));
  const timeout=setTimeout(()=>request.destroy(Error('request framing deadline')),5000);timeout.unref();
  completed.catch(()=>{});
  try{
   spec.run(request,events);assert.equal(await completed,'ok');await closed;
   return{...peer,events,finished:request.writableFinished,ended:request.writableEnded,
    headersSent:request.headersSent,streamPrototype:Object.getPrototypeOf(Object.getPrototypeOf(request))===api.OutgoingMessage.prototype};
  }finally{clearTimeout(timeout);request.destroy();}
 }
 try{return[await run(candidate),await run(http)];}
 finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
}
async function earlyResponseRetainsRealPendingWrite(){
 async function observe(api){
  const net=require('node:net'),{once}=require('node:events');
  let peer,request,physical;
  const server=net.createServer(socket=>{
   peer=socket;socket.once('data',()=>{socket.pause();socket.write('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n');});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const events=[];const errorSink=()=>{};
  try{
   request=api.request({host:'127.0.0.1',port:server.address().port,method:'POST',headers:{'Content-Length':8*1024*1024}});
   request.on('error',errorSink);request.on('finish',()=>events.push('finish'));request.on('close',()=>events.push('close'));
   const timeout=setTimeout(()=>request.destroy(Error('early response pending-write deadline')),8000);timeout.unref();
   try{
    const response=once(request,'response');request.end(Buffer.alloc(8*1024*1024,0x61));
    const[res]=await response;const signal=res.signal;events.push('response');const end=once(res,'end');res.resume();await end;events.push('end');
    physical=request.socket;
    assert.equal(res.socket,physical,'pending response/request must retain the actual socket');
    assert.equal(physical._poolTimer,undefined,'pending writer must not enter the idle pool');
    if(api===candidate)assert.equal(request._socket,physical);
    assert.equal(signal.aborted,false);
    assert.equal(request.writableFinished,false,'actual paused TCP peer must retain a real pending write');
    assert.equal(request.destroyed,false,'completed response cannot release an unfinished writer');
    const finish=once(request,'finish'),close=once(request,'close');peer.resume();await finish;await close;
    if(api===candidate)assert.equal(request._socket,null);
    assert.equal(signal.aborted,false,'response end detaches its abort signal before socket release');
    return{events,finished:request.writableFinished,responseComplete:res.complete,detached:res.socket===null};
   }finally{clearTimeout(timeout);}
  }finally{
   physical?.destroy();request?.socket?.destroy();peer?.destroy();request?.destroy();
   await new Promise(resolve=>server.close(resolve));
  }
 }
 const actual=await observe(candidate),expected=await observe(http);
 assert.deepEqual(actual,expected);return actual;
}
module.exports={earlyResponseRetainsRealPendingWrite};
if(require.main===module) (async()=>{
 const rows=[];
 for(const[name,spec]of Object.entries(cases)){
  const[a,e]=await compare(spec);
  assert.deepEqual(a,e,name);rows.push({name,result:a});
 }
 const early=await earlyResponseRetainsRealPendingWrite();rows.push({name:'earlyResponseRetainsRealPendingWrite',result:early});
 fs.writeFileSync(path.join(process.env.HTTP_OUTGOING_OUT,'request-rows.json'),JSON.stringify(rows,null,2)+'\n');
 console.log(JSON.stringify({requestFramingCases:rows.length,transport:'real native TCP/HTTP server peer and completed request/response events',
  source:'candidate ClientRequest/full OutgoingMessage/header/IncomingMessage/parser source with explicit native dependencies',guest:'not built/executed'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
