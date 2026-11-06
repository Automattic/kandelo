'use strict';
const assert=require('node:assert/strict'),net=require('node:net'),fs=require('node:fs'),path=require('node:path');
const {create,root}=require('./node-http-outgoing-platform.cjs');
const expected=require('node:_http_outgoing'),actual=create().module;
assert.equal(process.version,'v26.13.0');
assert.equal(Object.getPrototypeOf(actual.OutgoingMessage.prototype),require('node:stream').prototype);
assert.equal(Object.getPrototypeOf(actual.OutgoingMessage),require('node:stream'));
function descriptors(object){return Reflect.ownKeys(object).map(key=>{
 const d=Object.getOwnPropertyDescriptor(object,key);const label=typeof key==='symbol'?String(key):key;
 const shape={key:label,enumerable:d.enumerable,configurable:d.configurable};
 if('writable'in d)shape.writable=d.writable;
 if('value'in d)shape.value=typeof d.value==='function'?[d.value.name,d.value.length]:typeof d.value;
 if(d.get)shape.get=[d.get.name,d.get.length];if(d.set)shape.set=[d.set.name,d.set.length];return shape;
});}
assert.deepEqual(descriptors(actual),descriptors(expected));
assert.deepEqual(descriptors(actual.OutgoingMessage.prototype),descriptors(expected.OutgoingMessage.prototype));
const cases={
 endString(m){m.end('hello');},
 endBinary(m){m.end(Buffer.from([0,1,255,128]));},
 streamedChunked(m){m.write('hello');m.write(Buffer.from([0,255]));m.end();},
 emptyPost(m){m.end();},
 explicitLength(m){m.setHeader('Content-Length',5);m.end('hello');},
 strictLength(m){m.strictContentLength=true;m.setHeader('Content-Length',5);m.write('he');m.end('llo');},
 trailers(m){m.setHeader('Trailer','X-End');m.write('hello');m.addTrailers({'X-End':['first','second']});m.end();},
 corked(m){m.cork();m.write('one');m.write('two');m.uncork();m.end();},
 emptyChunks(m){m.write('');m.write(Buffer.alloc(0));m.end('last');},
 flushedHeaders(m){m.flushHeaders();m.write('hello');m.end();},
 latin1Headers(m){m.setHeader('X-Latin','\xff');m.end(Buffer.from('body'));},
 duplicateHeaders(m){m.setHeader('X-A',['one','two']);m.setHeader('Cookie',['a=1','b=2']);m.end('hello');},
};
async function wire(Ctor,operation){
 const bytes=[],events=[];let peerDone,peerFailed;
 const peerEnd=new Promise((resolve,reject)=>{peerDone=resolve;peerFailed=reject;});
 const sockets=new Set();
 const server=net.createServer(socket=>{
  sockets.add(socket);socket.on('data',b=>bytes.push(Buffer.from(b)));
  socket.on('error',peerFailed);socket.once('end',peerDone);socket.once('close',()=>sockets.delete(socket));
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const socket=net.createConnection(server.address().port,'127.0.0.1');
 const msg=new Ctor();msg._implicitHeader=function(){this._storeHeader('POST /wire HTTP/1.1\r\n',null);};
 socket._httpMessage=msg;msg.socket=socket;
 const finished=new Promise((resolve,reject)=>{
  msg.once('error',reject);socket.once('error',reject);
  msg.once('prefinish',()=>events.push('prefinish'));
  msg.once('finish',()=>{events.push('finish');socket.end();resolve();});
 });
 socket.once('connect',()=>msg._flush());
 peerEnd.catch(()=>{});finished.catch(()=>{});
 const deadline=setTimeout(()=>{const error=Error('outgoing TCP observation deadline');peerFailed(error);socket.destroy(error);},5000);deadline.unref();
 try{
  operation(msg);
  await finished;await peerEnd;
  return{wire:Buffer.concat(bytes).toString('hex'),events,finished:msg.writableFinished,ended:msg.writableEnded,
   headersSent:msg.headersSent,chunked:msg.chunkedEncoding};
 }finally{
  clearTimeout(deadline);socket.destroy();for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));
 }
}
(async()=>{
 const rows=[];
 for(const[name,operation]of Object.entries(cases)){
  const a=await wire(actual.OutgoingMessage,operation),e=await wire(expected.OutgoingMessage,operation);
  assert.deepEqual(a,e,name);rows.push({name,bytes:a.wire.length/2});
 }
 const validation={
  nullChunk(m){m.write(null);},numberChunk(m){m.write(1);},abstractHeader(m){m.write('x');},
  invalidHeader(m){m.setHeader('bad name','x');},invalidValue(m){m.setHeader('X','bad\nvalue');},
  invalidTrailer(m){m.addTrailers({'bad name':'x'});},
  fixedTrailer(m){m._implicitHeader=function(){this._storeHeader('POST / HTTP/1.1\r\n',this[Object.getOwnPropertySymbols(this).find(s=>s.description==='kOutHeaders')]);};m.setHeader('Content-Length',2);m.setHeader('Trailer','X-End');m.end('hi');},
  strictMismatch(m){m._implicitHeader=function(){this._storeHeader('POST / HTTP/1.1\r\n',this[Object.getOwnPropertySymbols(this).find(s=>s.description==='kOutHeaders')]);};m.strictContentLength=true;m.setHeader('Content-Length',3);m.end('four');},
 };
 function failure(Ctor,operation){const msg=new Ctor();try{operation(msg);return null;}catch(e){return{name:e.name,code:e.code,message:e.message};}finally{msg.destroy();}}
 for(const[name,operation]of Object.entries(validation)){assert.deepEqual(failure(actual.OutgoingMessage,operation),failure(expected.OutgoingMessage,operation),name);}
 const dated=m=>{m.sendDate=true;m.end('dated');};
 const a=await wire(actual.OutgoingMessage,dated),e=await wire(expected.OutgoingMessage,dated);
 function date(text){const match=/Date: ([^\r]+)\r\n/.exec(Buffer.from(text,'hex').toString('latin1'));assert(match);assert(Math.abs(Date.now()-Date.parse(match[1]))<2000);return Buffer.from(text,'hex').toString('latin1').replace(match[0],'');}
 assert.equal(date(a.wire),date(e.wire));rows.push({name:'actualClockDateHeader'});
 fs.writeFileSync(path.join(process.env.HTTP_OUTGOING_OUT,'component-rows.json'),JSON.stringify(rows,null,2)+'\n');
 console.log(JSON.stringify({outgoingComponentCases:rows.length,validationCases:Object.keys(validation).length,namespaceDescriptorGroups:2,transport:'actual native TCP sockets, EOF, write acknowledgments and completed close',
  source:'complete unchanged pinned OutgoingMessage with native stream/Buffer/async/clock dependencies',guest:'not built/executed'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
