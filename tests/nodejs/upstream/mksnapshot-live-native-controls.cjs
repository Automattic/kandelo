const {internalBinding}=require('internal/test/binding'),{writeSync}=require('node:fs');
const binding=internalBinding('mksnapshot'),startup=require('internal/v8/startup_snapshot'),observations=[];let failures=0;
function assert(value,message='native snapshot assertion failed'){if(!value)throw Error(message)}
function check(name,callback){try{observations.push({name,status:'pass',detail:callback()??true})}catch(error){failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message}})}}
function outcome(callback){try{const value=callback();return {value:value===undefined?'undefined':value}}catch(error){return {error:{name:error.name,code:error.code,message:error.message}}}}
check('binding-export-descriptors-and-live-state',()=>Object.fromEntries(Reflect.ownKeys(binding).map(name=>{
 const d=Object.getOwnPropertyDescriptor(binding,name),value=d.value;
 return [name,{writable:d.writable,enumerable:d.enumerable,configurable:d.configurable,value:typeof value==='function'?{type:'function',name:value.name,length:value.length}:value instanceof Uint8Array?{type:'Uint8Array',length:value.length,bytes:Array.from(value),bufferByteLength:value.buffer.byteLength}:value}];
})));
check('ordinary-mode-and-original-js-snapshot-guards',()=>{
 assert(binding.isBuildingSnapshotBuffer instanceof Uint8Array&&binding.isBuildingSnapshotBuffer.length===1&&binding.isBuildingSnapshotBuffer[0]===0);
 assert(startup.namespace.isBuildingSnapshot()===0);
 return [outcome(()=>startup.namespace.addSerializeCallback(()=>{})),outcome(()=>startup.namespace.addDeserializeCallback(()=>{})),outcome(()=>startup.namespace.setDeserializeMainFunction(()=>{})),outcome(()=>startup.throwIfBuildingSnapshot('ordinary live execution'))];
});
check('compile-serialize-main-builds-real-three-parameter-function',()=>{
 const fn=binding.compileSerializeMain('fixture:snapshot-main.js','return [require.marker,__filename,__dirname,arguments.length,this.marker];');
 assert(typeof fn==='function'&&fn.length===3);return {name:fn.name,length:fn.length,output:fn.call({marker:17},{marker:23},'actual-filename','actual-directory')};
});
check('compiled-function-retains-actual-source-and-pending-jobs',()=>{
 const fn=binding.compileSerializeMain('fixture:serialize-source.js','return (async()=>{await 0;return [__filename,require.marker]})();');
 gc();return fn({marker:29},'retained-filename','directory').then(value=>{assert(JSON.stringify(value)==='["retained-filename",29]');return value});
});
check('function-body-syntax-errors-propagate-real-exceptions',()=>{
 const result=outcome(()=>binding.compileSerializeMain('fixture:snapshot-invalid.js','return )'));
 assert(result.error&&result.error.name==='SyntaxError');return {name:result.error.name};
});
check('compiled-throw-keeps-real-filename-and-error-identity',()=>{
 const fn=binding.compileSerializeMain('fixture:snapshot-error.js','throw require.error;'),marker=Error('SOURCE_SNAPSHOT_ERROR');
 try{fn({error:marker},'x','y')}catch(error){assert(error===marker);return {same:true}}
 throw Error('compiled function did not throw');
});
check('ordinary-js-callback-runners-have-empty-real-queues',()=>{
 assert(startup.runDeserializeCallbacks()===undefined);assert(startup.addAfterUserSerializeCallback(()=>{},'data')===undefined);return true;
});
// The native setters register one callback of each kind without running it.
// No snapshot serialization or fake builder mode is enabled in this process.
let calls=0;
const weak=[];
for(const name of ['setSerializeCallback','setDeserializeCallback','setDeserializeMainFunction']){
 let callback=()=>calls++;weak.push(new WeakRef(callback));binding[name](callback);callback=null;
}
(async()=>{
 await new Promise(setImmediate);gc();await new Promise(setImmediate);gc();
 check('native-environment-retains-all-registered-callbacks-across-gc',()=>{assert(weak.every(ref=>typeof ref.deref()==='function'));assert(calls===0);return {retained:weak.length,called:calls}});
 for(const row of observations)if(row.detail&&typeof row.detail.then==='function')row.detail=await row.detail;
 writeSync(1,JSON.stringify({kind:'native-mksnapshot-live-reference',cases:observations.length,failures,observations})+'\n');if(failures)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1});
