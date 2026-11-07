const path = require('node:path');
const vm = require('node:vm');
require('internal/test/binding');
const mode=process.argv[2], kind=process.argv[3], repo=process.argv[4],dir=process.argv[5];
let api;
const M=mode==='native'?require('node:module'):(api=require(path.join(repo,'host/test/fixtures/node-module-records.cjs')).create({skipESMResolver:true,sameRealmCJS:true})).Module;
if(kind==='pending-format') {
 const records=vm.runInContext('_nodeModuleRecords',api.context);
 const mod=new M(path.join(dir,'pending.mjs'));mod.loaded=false;records.setFormat(mod,'module');
 let caught;try{records.cached(undefined,mod);}catch(error){caught={name:error.name,code:error.code,message:error.message};}
 console.log(JSON.stringify({kind,caught}));
} else {
 const req=M.createRequire(path.join(dir,'entry.cjs'));
 const value=req('./target.cjs'); // creates the real relative-resolution cache
 const filename=path.join(dir,'target.cjs'),mod=req.cache[filename];
 let reads=0;const original={sentinel:'loaded getter'};const events=[];
 Object.defineProperty(mod,'loaded',{configurable:true,get(){
   reads++;events.push('loaded');
   if(kind==='first-throw'||(kind==='second-throw'&&reads===2))throw original;
   return kind==='flip'&&reads>1;
 }});
 if(kind==='exports-getter')Object.defineProperty(mod,'exports',{configurable:true,get(){events.push('exports');return value;}});
 let returned,caught;
 try{returned=req('./target.cjs');}catch(error){caught={original:error===original};}
 console.log(JSON.stringify({kind,reads,events,identity:returned===value,ready:returned?.ready,caught}));
}
