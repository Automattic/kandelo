'use strict';
const fs=require('fs'),crypto=require('crypto'),vm=require('vm');
const out=process.env.KANDELO_VM_MODULES_CONTROL_OUT;
if(!out)throw Error('Set KANDELO_VM_MODULES_CONTROL_OUT');fs.mkdirSync(out,{recursive:true});
const observations=[];
function observe(name,run){try{observations.push({name,value:run()});}catch(e){observations.push({name,error:{name:e.name,code:e.code,message:e.message}});}}
observe('arbitrary static attributes',()=>new vm.SourceTextModule(`import 'dep' with {type:'custom', extra:'retained'}`,{identifier:'attributes'}).moduleRequests);
observe('source phase syntax',()=>new vm.SourceTextModule(`import source value from 'dep'`,{identifier:'phase'}).moduleRequests);
observe('negative offsets',()=>({status:new vm.SourceTextModule('export const value=1',{identifier:'offset',lineOffset:-1,columnOffset:-1}).status}));
observe('native code cache',()=>{const code='export const value=1',a=new vm.SourceTextModule(code,{identifier:'cache'}),bytes=a.createCachedData(),b=new vm.SourceTextModule(code,{identifier:'cache',cachedData:bytes});return{length:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),roundtrip:b.status};});
(async()=>{const m=new vm.SourceTextModule('export const value=42',{identifier:'deadline'});m.linkRequests([]);m.instantiate();try{await m.evaluate({timeout:100});observations.push({name:'owned positive timeout',value:{value:m.namespace.value,status:m.status}});}catch(e){observations.push({name:'owned positive timeout',error:{name:e.name,code:e.code,message:e.message}});}const report={scope:'Exact pinned native target observations only. Candidate SM rejection paths are source-backed/unexecuted and these observations are not candidate passes.',version:process.version,observations};fs.writeFileSync(out+'/native-observations.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));})().catch(e=>{console.error(e);process.exitCode=1});
