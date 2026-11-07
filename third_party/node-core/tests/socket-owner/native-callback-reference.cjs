'use strict';
// Exact pinned native observation only. This does not execute the candidate
// SpiderMonkey binding, whose callback/GC/realm acceptance remains unrun.
const assert=require('node:assert/strict'),net=require('node:net');
const async=require('node:async_hooks'),{once}=require('node:events');
assert.equal(process.version,'v26.13.0');
async function observe(mode){
 let peer,accept;const accepted=new Promise(resolve=>accept=resolve);
 const server=net.createServer(socket=>{peer=socket;accept();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const client=net.connect({host:'127.0.0.1',port:server.address().port});
 client.on('error',()=>{});await once(client,'connect');await accepted;
 const handle=client._handle,old=handle.getAsyncId(),rows=[];let next,armed=true;
 const replacement={type:handle.getProviderType(),handle};
 const role=id=>id===old?'old':id===next?'new':'other';
 const original=handle.onread;
 handle.onread=function(buffer){rows.push({kind:'onread',id:role(async.executionAsyncId()),
   oldResource:async.executionAsyncResource()===handle,newResource:async.executionAsyncResource()===replacement,bytes:buffer?.byteLength});if(mode==='close')require('node:fs').writeSync(2,JSON.stringify({scope:'native observation before uncaught destruction branch',mode,rows})+'\n');return Reflect.apply(original,this,[buffer]);};
 const hook=async.createHook({
  init(id,type,trigger,resource){if(resource===replacement){next=id;rows.push({kind:'reset-init',type,trigger:role(trigger),execution:role(async.executionAsyncId())});}},
  before(id){
   if(id!==old&&id!==next)return;
   rows.push({kind:'before',id:role(id),execution:role(async.executionAsyncId())});
   if(id===old&&armed){armed=false;rows.push({kind:'probe-before',pending:handle.hasPendingRead()});
    if(mode==='reset')handle.asyncReset(replacement);
    else if(mode==='stop')handle.readStop();
    else client.destroy();
   }
  },
  after(id){if(id===old||id===next)rows.push({kind:'after',id:role(id),execution:role(async.executionAsyncId())});},
 });
 const deadline=setTimeout(()=>client.destroy(Error('native callback reference deadline')),5000);deadline.unref();
 const closed=once(client,'close');
 client.on('data',chunk=>{rows.push({kind:'data',id:role(async.executionAsyncId()),body:chunk.toString(),oldResource:async.executionAsyncResource()===handle});client.destroy();});
 client.on('close',()=>rows.push({kind:'close',id:role(async.executionAsyncId()),replacementResource:async.executionAsyncResource()===replacement}));
 hook.enable();
 try{
  peer.write('payload');await closed;hook.disable();
  const callback=rows.find(row=>row.kind==='onread');assert.equal(callback?.bytes,7);assert.equal(callback.id,'old');assert.equal(callback.oldResource,mode!=='reset');assert.equal(callback.newResource,mode==='reset');
  const after=rows.find(row=>row.kind==='after');assert.equal(after.id,'old');assert.equal(after.execution,'old');
  if(mode==='reset'){assert.equal(rows.find(row=>row.kind==='data').id,'old');assert.equal(rows.find(row=>row.kind==='close').id,'new');}
  if(mode==='close')assert.equal(rows.some(row=>row.kind==='data'),false);
  return {mode,rows};
 }finally{hook.disable();clearTimeout(deadline);client.destroy();peer.destroy();await new Promise(resolve=>server.close(resolve));}
}
(async()=>{const rows=[];for(const mode of (process.argv[2]?[process.argv[2]]:['reset','stop','close']))rows.push(await observe(mode));console.log(JSON.stringify({scope:'pinned native reference only',rows}));})().catch(error=>{console.error(error);process.exitCode=1;});
