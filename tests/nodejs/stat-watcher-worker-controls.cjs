'use strict';
const {Worker}=require('node:worker_threads');const assert=require('node:assert/strict');const path=require('node:path');
const mode=process.argv[2];
const fixture=path.resolve(__dirname,'../../host/test/fixtures/node-stat-watcher-platform.cjs');
const code=`const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {parentPort}=require('node:worker_threads');
const subject=${JSON.stringify(mode)}==='component'?require(${JSON.stringify(fixture)}).create():{api:fs,close(){}};
const dir=fs.mkdtempSync(path.join(process.env.KANDELO_STAT_WATCHER_TMP||os.tmpdir(),'stat-worker-'));const file=path.join(dir,'missing');
const watcher=subject.api.watchFile(file,{interval:2},()=>{parentPort.postMessage({observed:true});});
parentPort.once('message',()=>{subject.api.unwatchFile(file);subject.close();fs.rmSync(dir,{recursive:true,force:true});parentPort.postMessage({stopped:true});});`;
(async()=>{
 const worker=new Worker(code,{eval:true});let observed=false,stopped=false;
 worker.on('message',message=>{if(message.observed&&!observed){observed=true;worker.postMessage('stop');}if(message.stopped)stopped=true;});
 await new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('exit',code=>{try{assert.equal(code,0);assert.equal(observed,true);assert.equal(stopped,true);resolve();}catch(error){reject(error);}});});
 console.log(JSON.stringify({mode,observed,stopped,workerExit:true,scope:'actual worker-local poll/close/component cleanup; guest worker bridge uncompiled'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
