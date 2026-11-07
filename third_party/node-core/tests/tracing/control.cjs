'use strict';
const assert=require('node:assert/strict');
const candidate=process.argv[2]==='candidate',kind=process.argv[3];
const platform=candidate?require('./platform.cjs'):undefined;
const api=candidate?platform.owner.tracing:require('node:trace_events');
const output=candidate?platform.owner.api:console;
const result={kind};
function capture(fn){try{return{value:fn()};}catch(e){return{name:e.name,code:e.code,message:e.message};}}
function descriptor(object,key){const d=Object.getOwnPropertyDescriptor(object,key);return{enumerable:d.enumerable,configurable:d.configurable,writable:d.writable,get:d.get?.name,set:d.set?.name,valueType:typeof d.value};}
if(kind==='public'){
 result.namespace=Object.keys(api);result.functions=Object.entries(api).map(([name,value])=>[name,value.name,value.length,descriptor(api,name)]);
 result.errors=[];
 for(const value of [undefined,null,true,1,'x',[],{}, {categories:undefined},{categories:null},{categories:0},{categories:'x'},{categories:[]},{categories:[1]},{categories:[Symbol('x')]}])result.errors.push(capture(()=>api.createTracing(value)));
 const t=api.createTracing({categories:['b','a','b']});
 result.initial=[t.enabled,t.categories,api.getEnabledCategories()];
 const prototype=Object.getPrototypeOf(t);result.prototype=Object.getOwnPropertyNames(prototype).map(k=>[k,descriptor(prototype,k)]);result.inspect=require('node:util').inspect(t);
 result.receiver=capture(()=>Reflect.apply(t.enable,{},[]));
 t.enable();t.enable();result.enabled=[t.enabled,api.getEnabledCategories()];
 const other=api.createTracing({categories:['b','c']});other.enable();result.overlap=api.getEnabledCategories();t.disable();result.oneRemaining=api.getEnabledCategories();other.disable();other.disable();result.final=api.getEnabledCategories();
}else if(kind==='snapshot'){
 const array=['b','a','b','\0hidden','\ue000','\u{10000}'];
 const t=api.createTracing({categories:array});array.splice(0,array.length,'changed');
 result.categories=t.categories;t.enable();result.enabled=api.getEnabledCategories();t.disable();result.final=api.getEnabledCategories();
 const t2=api.createTracing({categories:['']});t2.enable();result.empty=[t2.enabled,api.getEnabledCategories()];t2.disable();
}else if(kind==='getters'){
 let reads=0;const original={failure:true};const arr=[];
 Object.defineProperty(arr,0,{get(){if(++reads===2)throw original;return'node.console';},enumerable:true});arr.length=1;
 try{api.createTracing({categories:arr});result.identity=false;}catch(error){result.identity=error===original;}
 result.reads=reads;result.enabled=api.getEnabledCategories();
}else if(kind==='events'||kind==='exit-events'){
 const t=api.createTracing({categories:['node.console']});t.enable();
 output.count('counter');output.count('counter');output.countReset('counter');
 output.time('timer');output.timeLog('timer');output.timeEnd('timer');
 output.time('quote"\\line');output.timeEnd('quote"\\line');
 if(kind==='exit-events')process.on('exit',()=>{output.count('exit-counter');output.time('exit-timer');output.timeEnd('exit-timer');});
 else {t.disable();output.count('disabled');}
 result.enabled=api.getEnabledCategories();
}else if(kind==='overlap-events'){
 const one=api.createTracing({categories:['node.console']}),two=api.createTracing({categories:['node.console']});
 one.enable();two.enable();output.count('first');one.disable();output.count('second');two.disable();output.count('disabled');
}else if(kind==='worker-events'){
 const t=api.createTracing({categories:['node.console']});t.enable();output.count('main-event');
 const {Worker}=require('node:worker_threads');
 const code=candidate?`require(${JSON.stringify(require.resolve('./platform.cjs'))}).owner.api.count('worker-event');`:`console.count('worker-event');`;
 const w=new Worker(code,{eval:true});w.once('error',error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
}else if(kind==='open-error'){
 require('node:fs').mkdirSync('node_trace.1.log');
 const t=api.createTracing({categories:['node.console']});t.enable();output.count('open-fails');t.disable();result.final=api.getEnabledCategories();
}else if(kind==='worker-admission'){
 // The actual native main/Worker distinction supplies admission. No flag spoof.
 const {Worker}=require('node:worker_threads');
 const code=candidate?`const {parentPort}=require('node:worker_threads');try{require(${JSON.stringify(require.resolve('./platform.cjs'))}).owner.tracing;parentPort.postMessage({pass:false});}catch(e){parentPort.postMessage({code:e.code,name:e.name,message:e.message});}`:`const {parentPort}=require('node:worker_threads');try{require('node:trace_events');parentPort.postMessage({pass:false});}catch(e){parentPort.postMessage({code:e.code,name:e.name,message:e.message});}`;
 const w=new Worker(code,{eval:true});w.once('message',value=>{result.worker=value;});w.once('error',error=>{result.worker={harnessError:error.message};});
 process.on('beforeExit',()=>process.stdout.write('RESULT '+JSON.stringify(result)+'\n'));
}else throw new Error('unknown control '+kind);
if(kind!=='worker-admission')process.stdout.write('RESULT '+JSON.stringify(result)+'\n');
// Reference callback invokes the same owning Finish after all user exit
// listeners. Actual production join/teardown integration is source-only here.
if(candidate)process.on('exit',()=>{const error=platform.native.operatingSystem('trace-finish').error;if(error)throw new Error('Trace sink finalization failed: '+error);});
