'use strict';
// Identical public assertions for native and guest modes; no skip or identity spoof.
const definitions = {
 bootstrapData() {
const assert=require('node:assert/strict'),{Worker}=require('node:worker_threads');
const buffer=new ArrayBuffer(4);new Uint8Array(buffer).set([1,2,3,4]);
const shared=new SharedArrayBuffer(4),data={buffer,shared,map:new Map([['key',3n]])};data.self=data;
const worker=new Worker(`const assert=require('node:assert/strict'),wt=require('node:worker_threads');
assert(!wt.isMainThread);assert(wt.threadId>0);assert.strictEqual(wt.workerData.self,wt.workerData);
assert.strictEqual(wt.workerData.map.get('key'),3n);assert.strictEqual(new Uint8Array(wt.workerData.buffer)[2],3);
assert.strictEqual(require('node:path').basename('/nested/file'),'file');assert(require('node:fs').existsSync('.'));
assert.strictEqual(require('node:crypto').createHash('sha256').update('hello').digest('hex'),'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
const vm=require('node:vm'),c=vm.createContext(vm.constants.DONT_CONTEXTIFY);assert.strictEqual(vm.runInContext('globalThis',c),c);
new Int32Array(wt.workerData.shared)[0]=42;wt.parentPort.postMessage({ok:true});`,{eval:true,workerData:data,transferList:[buffer]});
assert.strictEqual(buffer.byteLength,0);assert.strictEqual(require('node:worker_threads').threadId,0);
const message=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
const exited=new Promise(resolve=>worker.once('exit',resolve));
(async()=>{assert.deepStrictEqual(await message,{ok:true});assert.strictEqual(await exited,0);assert.strictEqual(new Int32Array(shared)[0],42);assert.strictEqual(worker.threadId,-1);console.log('WORKER_BOOTSTRAP_DATA_OK')})().catch(e=>{console.error(e);process.exitCode=1});
 },
 messagesAndExit() {
const assert=require('node:assert/strict'),wt=require('node:worker_threads');
process.env.KANDELO_WORKER_OWNER_ENV='parent';wt.setEnvironmentData('sample',{value:5});
const worker=new wt.Worker(`const assert=require('node:assert/strict'),wt=require('node:worker_threads');
assert.strictEqual(process.env.KANDELO_WORKER_OWNER_ENV,'parent');process.env.KANDELO_WORKER_OWNER_ENV='child';
assert.deepStrictEqual(wt.getEnvironmentData('sample'),{value:5});
assert.throws(()=>process.chdir('/'),{code:'ERR_WORKER_UNSUPPORTED_OPERATION'});
assert.throws(()=>process.umask(0),{code:'ERR_WORKER_UNSUPPORTED_OPERATION'});
wt.parentPort.on('message',value=>{setImmediate(()=>{wt.parentPort.postMessage(value+1);wt.parentPort.close();process.exitCode=7})});`,{eval:true});
const events=[];worker.on('online',()=>{events.push('online');worker.postMessage(40)});
worker.on('message',value=>{assert.strictEqual(value,41);events.push('message')});
worker.on('error',e=>{console.error(e);process.exitCode=1});
worker.on('exit',code=>{assert.strictEqual(code,7);events.push('exit');assert.deepStrictEqual(events,['online','message','exit']);assert.strictEqual(process.env.KANDELO_WORKER_OWNER_ENV,'parent');console.log('WORKER_MESSAGES_EXIT_OK')});
 },
 independentTermination() {
const assert=require('node:assert/strict'),{Worker}=require('node:worker_threads');
const a=new Worker('while(true){}',{eval:true});
const b=new Worker(`const {parentPort}=require('node:worker_threads');parentPort.on('message',value=>{parentPort.postMessage(value);parentPort.close()})`,{eval:true});
const online=w=>new Promise((resolve,reject)=>{w.once('online',resolve);w.once('error',reject)});
const bExit=new Promise(resolve=>b.once('exit',resolve));
(async()=>{await Promise.all([online(a),online(b)]);assert.notStrictEqual(a.threadId,b.threadId);
assert.deepStrictEqual(await Promise.all([a.terminate(),a.terminate()]),[1,1]);assert.strictEqual(a.threadId,-1);
const message=new Promise((resolve,reject)=>{b.once('message',resolve);b.once('error',reject)});b.postMessage(73);
assert.strictEqual(await message,73);assert.strictEqual(await bExit,0);assert.strictEqual(await a.terminate(),undefined);
console.log('WORKER_INDEPENDENT_STOP_OK')})().catch(e=>{console.error(e);process.exitCode=1});
 },
 exceptionDelivery() {
const assert=require('node:assert/strict'),{Worker}=require('node:worker_threads');
const worker=new Worker('throw new Error("worker-owned-failure")',{eval:true});const order=[];
worker.once('online',()=>order.push('online'));
worker.once('error',error=>{assert.strictEqual(error.name,'Error');assert.strictEqual(error.message,'worker-owned-failure');order.push('error')});
worker.once('exit',code=>{assert.strictEqual(code,1);order.push('exit');assert.deepStrictEqual(order,['online','error','exit']);console.log('WORKER_EXCEPTION_OK')});
 },
 hostDataAfterBootstrap() {
const assert=require('node:assert/strict'),{Worker}=require('node:worker_threads');
const worker=new Worker(`const assert=require('node:assert/strict'),{parentPort,workerData}=require('node:worker_threads');
assert(workerData.blob instanceof Blob);assert.strictEqual(workerData.blob.size,3);
assert.deepStrictEqual(process.execArgv,workerData.flags);
workerData.blob.text().then(text=>parentPort.postMessage(text));`,{eval:true,workerData:{blob:new Blob(['abc']),flags:process.execArgv}});
const message=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
const exited=new Promise(resolve=>worker.once('exit',resolve));
(async()=>{assert.strictEqual(await message,'abc');assert.strictEqual(await exited,0);console.log('WORKER_HOST_DATA_OK')})().catch(e=>{console.error(e);process.exitCode=1});
 },
 fileAndLocalLoader() {
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{Worker}=require('node:worker_threads');
const filename=path.join(os.tmpdir(),'node-worker-owner-'+process.pid+'-'+Date.now()+'.cjs'),dep=filename+'.dep.cjs';
fs.writeFileSync(dep,'module.exports=40');
fs.writeFileSync(filename,"const{parentPort,workerData}=require('node:worker_threads');parentPort.postMessage(require("+JSON.stringify('./'+path.basename(dep))+")+workerData)");
(async()=>{try{const worker=new Worker(filename,{workerData:2});
const message=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
const exited=new Promise(resolve=>worker.once('exit',resolve));
assert.strictEqual(await message,42);assert.strictEqual(await exited,0);console.log('WORKER_FILE_LOADER_OK');
}finally{fs.unlinkSync(filename);fs.unlinkSync(dep)}})().catch(e=>{console.error(e);process.exitCode=1});
 },

};
const cases=Object.fromEntries(Object.entries(definitions).map(([name,body])=>[name,'(function '+body.toString()+')();']));
module.exports={cases};
