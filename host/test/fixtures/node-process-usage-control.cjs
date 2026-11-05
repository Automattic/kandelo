'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),util=require('node:util'),os=require('node:os');
const target=require('../../../packages/registry/node-compat/target.json');assert.equal(process.versions.node,target.version);
const root=path.resolve(__dirname,'../../..'),source=fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
const factories=Function(source+';return { usage:_createNodeProcessUsage, unavailable:_createNodeUnavailableProcessUsage, values:_createNodeValuesPlatform, uv:_createNodeUvPlatform };')();
const uv=factories.uv({native:{getUvErrorData:()=>[...util.getSystemErrorMap()].map(([n,[name,message]])=>[n,name,message])}});
const boundary={platform:'kandelo',emitWarning:process.emitWarning.bind(process),nextTick:process.nextTick.bind(process)};
const values=factories.values({process:boundary,uv,Buffer,util,inspection:util,os,signals:os.constants.signals,getDOMException:()=>DOMException});
const recorded={};const resourceKeys=Object.keys(process.resourceUsage());
const binding={
 cpuUsage(out){const v=process.cpuUsage();recorded.cpu=v;out[0]=v.user;out[1]=v.system;},
 threadCpuUsage(out){const v=process.threadCpuUsage();recorded.thread=v;out[0]=v.user;out[1]=v.system;},
 memoryUsage(out){const v=process.memoryUsage();recorded.memory=v;['rss','heapTotal','heapUsed','external','arrayBuffers'].forEach((key,i)=>out[i]=v[key]);},
 rss(){const v=process.memoryUsage.rss();recorded.rss=v;return v;},
 resourceUsage(out){const v=process.resourceUsage();recorded.resource=v;resourceKeys.forEach((key,i)=>out[i]=v[key]);},
};
const subject=factories.usage({process:boundary,values,binding});
const missing=factories.usage({process:boundary,values,binding:factories.unavailable(values)});
function error(e){return{name:e.name,code:e.code,message:e.message,keys:Object.keys(e)}}
function thrown(fn){try{fn()}catch(e){return error(e)}throw Error('Expected failure')}
const cases={
 validation(){
  for(const method of ['cpuUsage','threadCpuUsage']){
   for(const value of [1,'x',true,[],{}, {user:-1,system:0},{user:0,system:NaN},{user:Infinity,system:0},{user:0,system:2**53}])
    assert.deepStrictEqual(thrown(()=>subject[method](value)),thrown(()=>process[method](value)));
   const fail=Error('getter');assert.throws(()=>subject[method]({get user(){throw fail}}),e=>e===fail);
   assert.equal(subject[method].name,process[method].name);assert.equal(subject[method].length,process[method].length);
  }
 },
 cpuValuesAndGetterOrder(){
  for(const [method,key] of [['cpuUsage','cpu'],['threadCpuUsage','thread']]){
   assert.deepStrictEqual(subject[method](),recorded[key]);
   for(const previous of [undefined,null,false,0,'']) assert.deepStrictEqual(subject[method](previous),recorded[key]);
   const previous={user:15,system:4};const actual=subject[method](previous);
   assert.deepStrictEqual(actual,{user:recorded[key].user-15,system:recorded[key].system-4});
   function trace(api){const reads=[];api({get user(){reads.push('user');return 0},get system(){reads.push('system');return 0}});return reads}
   assert.deepStrictEqual(trace(subject[method]),trace(process[method]));
  }
 },
 memoryAndResourceFieldMapping(){
  assert.deepStrictEqual(subject.memoryUsage(),recorded.memory);
  assert.deepStrictEqual(Object.keys(subject.memoryUsage()),Object.keys(process.memoryUsage()));
  assert.equal(subject.memoryUsage.rss,binding.rss);assert.equal(subject.memoryUsage.rss(),recorded.rss);
  assert.deepStrictEqual(subject.resourceUsage(),recorded.resource);
  assert.deepStrictEqual(Object.keys(subject.resourceUsage()),resourceKeys);
 },
 explicitMissingProviders(){
  for(const method of ['cpuUsage','threadCpuUsage','memoryUsage','resourceUsage'])
   assert.throws(()=>missing[method](),{code:'ERR_METHOD_NOT_IMPLEMENTED'});
  assert.throws(()=>missing.memoryUsage.rss(),{code:'ERR_METHOD_NOT_IMPLEMENTED'});
  assert.deepStrictEqual(thrown(()=>missing.cpuUsage({user:-1,system:0})),thrown(()=>process.cpuUsage({user:-1,system:0})));
 },
 actualMetadataConsumers(){
  const bootstrap=fs.readFileSync(path.join(root,'packages/registry/node-compat/bootstrap.js'),'utf8');
  const a=bootstrap.indexOf("    'v8': {"),b=bootstrap.indexOf("    'vm':",a);
  const body=bootstrap.slice(a,b).replace(/^    'v8': /,'').replace(/,\s*$/,'');
  const {createNativeAdapter}=require('./node-native-adapter.cjs');let called=0,measured;
  const adapter=createNativeAdapter({engineGcHeapLimit(){called++;return measured=require('node:v8').getHeapStatistics().heap_size_limit;}});
  const api=Function('_nodeNative','_nodeValues','return ('+body+');')(adapter,values);
  assert.deepStrictEqual(api.getHeapStatistics(),{heap_size_limit:measured});assert.equal(called,1);
  assert.throws(()=>api.getHeapSpaceStatistics(),{code:'ERR_METHOD_NOT_IMPLEMENTED'});
  const line=bootstrap.split('\n').find(s=>s.includes('getReport() { throw new _nodeValues'));
  const report=Function('_nodeValues','return ({'+line.trim()+'});')(values);
  assert.throws(()=>report.getReport(),{code:'ERR_METHOD_NOT_IMPLEMENTED'});
 }
};
const name=process.argv[2];assert.equal(typeof cases[name],'function');cases[name]();
console.log(JSON.stringify({case:name,passed:true,kind:['explicitMissingProviders','actualMetadataConsumers'].includes(name)?'gap/provider guard, not complete API support':'Pinned frontend algorithms over actual native Node accounting boundary; not guest measurements'}));
