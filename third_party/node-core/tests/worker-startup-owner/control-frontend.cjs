'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const{internalBinding,primordials}=require('internal/test/binding');const{MessageChannel,receiveMessageOnPort}=require('node:worker_threads');const protocol=require('internal/worker/js_transferable');
const tree=process.argv[2];const raw=fs.readFileSync(path.join(tree,'third_party/node-core/worker-platform-adapter.js'),'utf8');
const create=Function('_createNodePrimordials',raw+';return _createNodeWorkerPlatform;')(()=>primordials);const rows=[];
function cloneHost(kind,error,log,name){const host=new Blob(['actual Blob']);const key=Reflect.ownKeys(Blob.prototype).find(k=>typeof k==='symbol'&&k.description==='messaging_clone_symbol');Object.defineProperty(host,key,{value(){log.push(name+':clone');if(kind==='none')return undefined;return{data:{},deserializeInfo:kind==='error'?{toString(){log.push(name+':string');throw error;}}:'internal/abort_controller:ClonedAbortSignal'};}});return host;}
function transferHost(kind,error,log){const host={};protocol.markTransferMode(host,false,true);host[protocol.kTransfer]=()=>{log.push('input:transfer');if(kind==='none')return undefined;return{data:{},deserializeInfo:kind==='error'?{toString(){log.push('input:string');throw error;}}:'internal/abort_controller:ClonedAbortSignal'};};return host;}
const baseline=JSON.parse(fs.readFileSync(process.argv[3],'utf8')).rows;
for(const ref of baseline){
 const{dataKind,argvKind,inputKind}=ref;const log=[],argvError=new Error('argv'),inputError=new Error('input');const blob=cloneHost(argvKind,argvError,log,'argv');const argv=['mapped'];argv.constructor={[Symbol.species]:function(){return blob;}};const input=dataKind==='transfer'?transferHost(inputKind,inputError,log):cloneHost(inputKind,inputError,log,'input');
 const queues=[],metadata=[],boundary=new Error('STOP: native Kandelo Worker create is not executed');let calls=0;
 const owner=create({environment:null,process,EventEmitter:require('node:events'),values:{errors:require('internal/errors'),validators:require('internal/validators')},cliOptions:{conditions:['node'],evalSource:'parent entry is not child data'},ports:{adopt(){throw new Error('No candidate child adoption may be manufactured');}},native:{serializeMessage(value,transfer){calls++;if(calls===1){assert.deepEqual(Object.keys(value),['env','cliOptions']);assert.equal('evalSource' in value.cliOptions,false);metadata.push(structuredClone(value));return metadata[0];}assert.equal(calls,2);assert.deepEqual(Object.keys(value),['argv','filename','doEval','workerData','environmentData']);assert.equal(value.argv,blob);assert.equal(value.workerData,input);const pair=new MessageChannel();queues.push(pair);pair.port1.postMessage(value,transfer);return pair.port2;},worker(operation,queue,config){assert.equal(operation,'create');assert.ok(queues.some(p=>p.port2===queue));assert.equal(config,metadata[0]);throw boundary;}}});
 let error;try{new owner.api.Worker('',{eval:true,argv,workerData:input,transferList:dataKind==='transfer'?[input]:[]});}catch(e){error=e;}
 if(ref.error){assert.equal(error,ref.error.argvIdentity?argvError:inputError);}else assert.equal(error,boundary);
 assert.deepEqual(log,ref.log);assert.equal(calls,2);
 for(const q of queues){q.port2.on('messageerror',()=>{});q.port1.close();q.port2.close();}
 rows.push({dataKind,argvKind,inputKind,matchingNativeHookOrder:true,matchingOriginalSenderException:!!ref.error,stoppedBeforeCandidateNativeCreate:!ref.error,actualNativeQueueDependency:true});
}
console.log(JSON.stringify({rows,scope:'Actual candidate Worker frontend over actual pinned native MessagePort serialization only; stops before Kandelo native create/adoption. No candidate JSAPI/gate/Worker/guest execution claim.'}));
