/** Public programs shared unchanged by the exact native oracle and guests. */
export const nodeSocketTimeoutCases = [
  {name:'validation-and-constructors', source:`
const assert=require('assert'),net=require('net');
assert.strictEqual(net.connect,net.createConnection);
const socket=net.Socket();assert(socket instanceof net.Socket);
const server=net.Server();assert(server instanceof net.Server);
class S extends net.Socket {} class L extends net.Server {}
assert(new S() instanceof S);assert(new L() instanceof L);
for(const value of [-1,1.2,NaN,Infinity]) assert.throws(()=>new net.Socket({fd:value}),{code:'ERR_OUT_OF_RANGE'});
for(const value of ['1',{},true]) assert.throws(()=>new net.Socket({fd:value}),{code:'ERR_INVALID_ARG_TYPE'});
for(const value of ['100',true,false,undefined,null,'',{},()=>{},[]]) assert.throws(()=>socket.setTimeout(value),{code:'ERR_INVALID_ARG_TYPE'});
for(const value of [-0.001,-1,-Infinity,Infinity,NaN]) assert.throws(()=>socket.setTimeout(value),{code:'ERR_OUT_OF_RANGE'});
for(const value of [0,0.001,1,1000000]) assert.strictEqual(socket.setTimeout(value),socket);
for(const callback of [1,'100',true,false,null,{},[],Symbol('bad')]) for(const ms of [0,1]) assert.throws(()=>socket.setTimeout(ms,callback),{code:'ERR_INVALID_ARG_TYPE'});
let called=0;const a=()=>called++,b=()=>called++;
socket.setTimeout(100,a);socket.setTimeout(100,b);
assert.strictEqual(socket.listenerCount('timeout'),2);
socket.setTimeout(0,a);assert.strictEqual(socket.listenerCount('timeout'),1);
socket.removeAllListeners('timeout');socket.destroy();
assert.strictEqual(socket.setTimeout('invalid',null),socket);
assert.strictEqual(called,0);
console.log('node-socket-timeouts-validation-and-constructors-ok');
`},
  {name:'idle-notification', source:`
const assert=require('assert'),net=require('net');
let timed=0,closed=0;
const server=net.createServer(socket=>socket.on('error',e=>{throw e;}));
server.listen(0,'127.0.0.1',()=>{
 const client=net.connect({host:'127.0.0.1',port:server.address().port});
 client.on('error',e=>{throw e;});
 client.setTimeout(30,function(){
  assert.strictEqual(this,client);assert.strictEqual(client.destroyed,false);
  assert.strictEqual(client.timeout,30);timed++;client.end();
 });
 client.on('close',()=>{closed++;server.close(()=>{
  assert.strictEqual(timed,1);assert.strictEqual(closed,1);
  console.log('node-socket-timeouts-idle-notification-ok');
 });});
});
`},
  {name:'read-activity', source:`
const assert=require('assert'),net=require('net');let seen=0;
const server=net.createServer(socket=>{
 // Keep activity going past the original deadline: without read refresh,
 // the timeout fires before all eight bytes arrive.
 let sent=0;const beat=setInterval(()=>{socket.write('x');if(++sent===8)clearInterval(beat);},50);
 socket.on('error',e=>{clearInterval(beat);throw e;});socket.on('close',()=>clearInterval(beat));
});
server.listen(0,'127.0.0.1',()=>{
 const client=net.connect({host:'127.0.0.1',port:server.address().port});
 client.on('error',e=>{throw e;});client.on('data',b=>seen+=b.length);
 client.setTimeout(200,()=>{assert.strictEqual(seen,8);client.end();});
 client.on('close',()=>server.close(()=>console.log('node-socket-timeouts-read-activity-ok')));
});
`},
  {name:'write-rearms-after-timeout', source:`
const assert=require('assert'),net=require('net');let timed=0,seen=0;
const server=net.createServer(socket=>{
 socket.on('data',b=>seen+=b.length);socket.on('error',e=>{throw e;});
});
server.listen(0,'127.0.0.1',()=>{
 const client=net.connect({host:'127.0.0.1',port:server.address().port});
 client.on('error',e=>{throw e;});client.setTimeout(30);
 client.on('timeout',()=>{
  if(++timed===1)client.write('activity');
  else {assert.strictEqual(timed,2);assert.strictEqual(seen,8);client.setTimeout(0);client.end();}
 });
 client.on('close',()=>server.close(()=>console.log('node-socket-timeouts-write-rearms-after-timeout-ok')));
});
`},
  {name:'connection-option-and-cancel', source:`
const assert=require('assert'),net=require('net');let timers=0;
const server=net.createServer(socket=>{socket.write('ready');socket.on('error',e=>{throw e;});});
server.listen(0,'127.0.0.1',()=>{
 const client=net.createConnection({host:'127.0.0.1',port:server.address().port,timeout:30});
 client.on('error',e=>{throw e;});client.on('timeout',()=>{
  timers++;assert.strictEqual(client.timeout,30);client.setTimeout(0);
  setTimeout(()=>{assert.strictEqual(timers,1);client.destroy();},80);
 });
 client.on('close',()=>server.close(()=>console.log('node-socket-timeouts-connection-option-and-cancel-ok')));
});
`},
  {name:'no-handle-unref-and-destroy', source:`
const assert=require('assert'),net=require('net');const socket=new net.Socket();let count=0;
socket.setTimeout(20,function(){assert.strictEqual(this,socket);assert.strictEqual(socket.destroyed,false);count++;socket.destroy();socket.setTimeout(1,()=>{throw Error('destroyed socket rearmed');});});
setTimeout(()=>{assert.strictEqual(count,1);console.log('node-socket-timeouts-no-handle-unref-and-destroy-ok');},70);
`},
  {name:'unref-does-not-keep-alive', source:`
const net=require('net');new net.Socket().setTimeout(1000,()=>{throw Error('unref timeout retained process');});
process.on('exit',()=>console.log('node-socket-timeouts-unref-does-not-keep-alive-ok'));
`},
];
const quote=(value:string)=>`'${value.replace(/'/g, `'"'"'`)}'`;
export const nodeSocketTimeoutExpected=nodeSocketTimeoutCases.map(c=>`node-socket-timeouts-${c.name}-ok`);
export const nodeSocketTimeoutCommand='set -eu\n'+nodeSocketTimeoutCases.map(c=>`node -e ${quote(c.source)}\n`).join('');
