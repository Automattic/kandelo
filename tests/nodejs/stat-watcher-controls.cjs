'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {pathToFileURL}=require('node:url');
const component=process.argv[2]==='component';
const subject=component?require('../../host/test/fixtures/node-stat-watcher-platform.cjs').create():{api:fs,close(){}};
const api=subject.api;const dir=fs.mkdtempSync(path.join(process.env.KANDELO_STAT_WATCHER_TMP||os.tmpdir(),'stat-watch-'));
const rows=[];
async function lifecycle(bigint){
 const file=path.join(dir,bigint?'bigint':'number');const seen=[];let watcher;
 await new Promise((resolve,reject)=>{
  function changed(curr,prev){
   try{
    const step=seen.length;const record={type:typeof curr.size,current:String(curr.size),previous:String(prev.size),currentLinks:String(curr.nlink),previousLinks:String(prev.nlink),currentFile:curr.isFile(),previousFile:prev.isFile(),date:curr.mtime instanceof Date};seen.push(record);
    assert.equal(this,watcher);assert.equal(record.type,bigint?'bigint':'number');assert.equal(record.date,true,JSON.stringify(record));
    if(curr.size!==(bigint?0n:0)){
     const actual=fs.statSync(file,{bigint});
     for(const field of ['dev','mode','nlink','uid','gid','rdev','blksize','ino','size','blocks','atimeMs','mtimeMs','ctimeMs','birthtimeMs'])assert.equal(curr[field],actual[field],field);
     if(bigint)for(const field of ['atimeNs','mtimeNs','ctimeNs','birthtimeNs'])assert.equal(curr[field],actual[field],field);
    }
    if(step===0){assert.equal(record.current,'0');assert.equal(record.previous,'0');fs.writeFileSync(file,'abc');fs.utimesSync(file,new Date('2100-01-01T00:00:00Z'),new Date('2100-01-01T00:00:00Z'));}
    else if(step===1){assert.equal(record.current,'3');assert.equal(record.previous,'0');assert.equal(Number(curr.mtimeMs),4102444800000);record.futureMtime=true;curr.size=bigint?999n:999;fs.appendFileSync(file,'de');}
    else if(step===2){assert.equal(record.current,'5');assert.equal(record.previous,'3');fs.unlinkSync(file);}
    else if(step===3){assert.equal(record.current,'0');assert.equal(record.previous,'5');fs.writeFileSync(file,'x');}
    else if(step===4){assert.equal(record.current,'1');assert.equal(record.previous,'5');api.unwatchFile(file);resolve();}
    else throw Error('Unexpected extra poll event');
   }catch(error){api.unwatchFile(file);reject(error);}
  }
  watcher=api.watchFile(file,{interval:5,bigint},changed);
  assert.equal(watcher.ref(),watcher);assert.equal(watcher.unref(),watcher);assert.equal(watcher.ref(),watcher);
  assert.equal(typeof watcher.stop,'function');assert.equal(watcher.start(),undefined);
 });
 rows.push({name:bigint?'bigint-lifecycle':'number-lifecycle',events:seen});
}
async function sharing(){
 const file=path.join(dir,'shared');let secondCount=0,stops=0;let first,second;
 const done=new Promise((resolve,reject)=>{
  function one(curr,prev){try{assert.equal(typeof curr.size,'number');assert.equal(curr.size,0);api.unwatchFile(file,one);assert.equal(first.listenerCount('change'),1);api.unwatchFile(file,two);}catch(error){reject(error);}}
  function two(){secondCount++;}
  first=api.watchFile(file,{interval:0,bigint:false,persistent:false},one);
  second=api.watchFile(pathToFileURL(file),{interval:-99,bigint:true,persistent:true},two);
  assert.equal(first,second);first.on('stop',()=>{stops++;resolve();});
  first.ref();
 });
 await done;assert.equal(secondCount,1);assert.equal(stops,1);assert.equal(first._handle,null);
 assert.equal(first.ref(),first);assert.equal(first.unref(),first);assert.equal(first.stop(),undefined);
 rows.push({name:'shared-path-first-options-win',secondCount,stops});
}
async function errors(){
 const parent=path.join(dir,'error-parent'),file=path.join(parent,'file');const statuses=[];let watcher;
 await new Promise((resolve,reject)=>{
  let count=0;
  watcher=api.watchFile(file,{interval:5},(curr,prev)=>{
   try{
    if(count<3){assert.equal(curr.size,0);assert.equal(prev.size,0);}
    if(count===0)fs.writeFileSync(parent,'not-a-directory');
    else if(count===1)fs.unlinkSync(parent);
    else if(count===2){fs.mkdirSync(parent);fs.writeFileSync(file,'real');}
    else if(count===3){assert.equal(curr.size,4);api.unwatchFile(file);resolve();}
    else throw Error('Unexpected repeated error callback');
    count++;
   }catch(error){api.unwatchFile(file);reject(error);}
  });
  const change=watcher._handle.onchange;
  watcher._handle.onchange=function(status,stats){statuses.push(status);return change.call(this,status,stats);};
 });
 assert.deepEqual(statuses,[-2,-20,-2,0]);rows.push({name:'actual-error-transitions',statuses});
}
(async()=>{
 assert.throws(()=>api.watchFile(path.join(dir,'invalid')),{code:'ERR_INVALID_ARG_TYPE'});
 assert.throws(()=>api.watchFile(path.join(dir,'bad-interval'),{interval:-1},()=>{}),{code:'ERR_OUT_OF_RANGE'});
 assert.equal(api.unwatchFile(path.join(dir,'unused')),undefined);
 await lifecycle(false);await lifecycle(true);await sharing();await errors();
 console.log(JSON.stringify({node:process.version,mode:component?'actual-portable-poll-component':'exact-native',rows,scope:component?'real portable poll + POSIX asynchronous work, public algorithms; SpiderMonkey/guest/loop integration uncompiled':'exact pinned native reference'}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{for(const name of ['number','bigint','shared','bad-interval','error-parent/file'])api.unwatchFile(path.join(dir,name));subject.close();fs.rmSync(dir,{recursive:true,force:true});});
