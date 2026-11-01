/** Independent POSIX reader makes native partial-write progress observable. */
export const nodeSocketWriteProgressSource=`
const assert=require('assert'),net=require('net'),cp=require('child_process');
let peerDone=false,serverDone=false,wrote=false;
function done(){if(peerDone&&serverDone){assert(wrote);console.log('node-socket-timeouts-native-write-progress-ok');}}
const server=net.createServer(socket=>{
 socket.on('error',error=>{throw error;});
 socket.setTimeout(100,()=>{throw Error('write timed out while bytes were moving');});
 socket.write(Buffer.alloc(2097152,65),error=>{
  assert.ifError(error);assert.strictEqual(socket._handle.writeQueueSize,0);wrote=true;socket.setTimeout(0);socket.end();
 });
 server.close(()=>{serverDone=true;done();});
});
server.listen(0,'127.0.0.1',()=>{
 const peer=cp.spawn('/node-src/socket-write-peer.wasm',[String(server.address().port)]);
 let stdout='',stderr='';peer.stdout.on('data',b=>stdout+=b.toString());peer.stderr.on('data',b=>stderr+=b.toString());
 peer.on('error',error=>{throw error;});peer.stdin.end();
 peer.on('close',(status,signal)=>{assert.strictEqual(status,0,stderr);assert.strictEqual(signal,null);assert.strictEqual(stdout.trim(),'socket-write-peer-ok');peerDone=true;done();});
});
`;
