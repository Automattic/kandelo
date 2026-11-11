// Shared native-reference/guest assertions. The harness supplies the actual
// binding, unchanged internal/async_hooks module and check/assertEq functions.
check('native-stack-push-pop-restores-live-ids',()=>{
  binding.clearAsyncIdStack();const c=binding.constants,f=binding.async_hook_fields,ids=binding.async_id_fields;
  ids[c.kExecutionAsyncId]=17;ids[c.kTriggerAsyncId]=11;
  assertEq(binding.pushAsyncContext(23,19),undefined);assertEq(f[c.kStackLength],1);assertEq(ids[c.kExecutionAsyncId],23);assertEq(ids[c.kTriggerAsyncId],19);
  binding.pushAsyncContext(29,23);assertEq(binding.popAsyncContext(29),true);assertEq(ids[c.kExecutionAsyncId],23);
  assertEq(binding.popAsyncContext(23),false);assertEq(ids[c.kExecutionAsyncId],17);assertEq(ids[c.kTriggerAsyncId],11);assertEq(binding.popAsyncContext(-99),false);
});
check('native-stack-growth-publishes-three-times-the-backing',()=>{
  binding.clearAsyncIdStack();const c=binding.constants,old=binding.async_ids_stack,frames=old.length/2+1;
  for(let i=0;i<frames;i++)binding.pushAsyncContext(i+1,i);
  assertEq(binding.async_ids_stack===old,false);assertEq(binding.async_ids_stack.length,old.length*3);
  assertEq(binding.async_ids_stack[2*(frames-1)],frames-1);
  for(let i=frames;i>0;i--)assertEq(binding.popAsyncContext(i),i>1);
  assertEq(binding.async_hook_fields[c.kStackLength],0);
});
check('native-id-conversion-and-disabled-checks-use-live-fields',()=>{
  binding.clearAsyncIdStack();const c=binding.constants,f=binding.async_hook_fields;let reads=0;
  binding.pushAsyncContext({valueOf(){reads++;return 7}},'3');assertEq(reads,1);assertEq(binding.async_id_fields[c.kExecutionAsyncId],7);assertEq(binding.popAsyncContext('7'),false);
  const saved=f[c.kCheck];try{f[c.kCheck]=0;binding.pushAsyncContext(NaN,-9);assertEq(Number.isNaN(binding.async_id_fields[c.kExecutionAsyncId]),true);assertEq(binding.popAsyncContext(123),false)}finally{f[c.kCheck]=saved;binding.clearAsyncIdStack()}
});
check('native-resource-vector-has-no-array-prototype-fallback',()=>{
  binding.clearAsyncIdStack();const saved=Object.getOwnPropertyDescriptor(Array.prototype,'0');
  try{Object.defineProperty(Array.prototype,'0',{value:{poison:true},configurable:true});for(const index of [0,-1,0xffffffff,0x80000000,2**32])assertEq(binding.executionAsyncResource(index),undefined)}finally{if(saved)Object.defineProperty(Array.prototype,'0',saved);else delete Array.prototype[0]}
  let error;try{binding.executionAsyncResource(Symbol())}catch(e){error=e}assertEq(error instanceof TypeError,true);
});
check('clear-resets-stack-resources-without-resetting-counter-or-default',()=>{
  binding.clearAsyncIdStack();const c=binding.constants,f=binding.async_hook_fields,ids=binding.async_id_fields;
  const counter=ids[c.kAsyncIdCounter],trigger=ids[c.kDefaultTriggerAsyncId];ids[c.kAsyncIdCounter]=123;ids[c.kDefaultTriggerAsyncId]=9;
  binding.pushAsyncContext(10,4);binding.execution_async_resources.push({});const old=binding.async_ids_stack;
  binding.clearAsyncIdStack();assertEq(f[c.kStackLength],0);assertEq(ids[c.kExecutionAsyncId],0);assertEq(ids[c.kTriggerAsyncId],0);assertEq(ids[c.kAsyncIdCounter],123);assertEq(ids[c.kDefaultTriggerAsyncId],9);assertEq(binding.execution_async_resources.length,0);assertEq(binding.async_ids_stack,old);
  ids[c.kAsyncIdCounter]=counter;ids[c.kDefaultTriggerAsyncId]=trigger;
});
check('unchanged-internal-module-allocates-ids-and-restores-default-scope',()=>{
  binding.clearAsyncIdStack();const c=binding.constants,ids=binding.async_id_fields,counter=ids[c.kAsyncIdCounter],old=ids[c.kDefaultTriggerAsyncId];
  assertEq(internalHooks.newAsyncId(),counter+1);assertEq(ids[c.kAsyncIdCounter],counter+1);
  const marker={};let caught;try{internalHooks.defaultTriggerAsyncIdScope(83,()=>{assertEq(internalHooks.getDefaultTriggerAsyncId(),83);throw marker})}catch(e){caught=e}
  assertEq(caught,marker);assertEq(ids[c.kDefaultTriggerAsyncId],old);
});
check('unchanged-internal-module-uses-js-and-native-growing-stack',()=>{
  binding.clearAsyncIdStack();const c=binding.constants,resources=[],frames=binding.async_ids_stack.length/2+2;
  for(let i=0;i<frames;i++){const resource={i};resources.push(resource);internalHooks.pushAsyncContext(i+1,i,resource);assertEq(internalHooks.executionAsyncResource(),resource)}
  assertEq(binding.async_hook_fields[c.kStackLength],frames);
  for(let i=frames;i>0;i--){assertEq(internalHooks.executionAsyncId(),i);assertEq(internalHooks.triggerAsyncId(),i-1);assertEq(internalHooks.executionAsyncResource(),resources[i-1]);assertEq(internalHooks.popAsyncContext(i),i>1)}
  assertEq(binding.execution_async_resources.length,0);
});
check('promise-hook-empty-registration-is-an-actual-fresh-array',()=>{
  binding.setPromiseHooks(undefined,null,false,17);const first=binding.getPromiseHooks(),second=binding.getPromiseHooks();
  assertEq(first===second,false);assertEq(first.length,4);assertEq(first.every(v=>v===undefined),true);first[0]=()=>{};assertEq(binding.getPromiseHooks()[0],undefined);
});
check('assigned-promise-rejections-enter-actual-ids-and-resource',()=>{
  binding.clearAsyncIdStack();const c=binding.constants,events=[];let reject;
  const promise=new Promise((resolve,r)=>reject=r),reason={};promise[symbols.async_id_symbol]=37;promise[symbols.trigger_async_id_symbol]=19;
  rejectionQueue.setPromiseRejectCallback((type,p,value)=>{events.push(type);assertEq(p,promise);assertEq(value,type===0?reason:undefined);assertEq(internalHooks.executionAsyncId(),37);assertEq(internalHooks.triggerAsyncId(),19);assertEq(internalHooks.executionAsyncResource(),promise);gc('shrinking');assertEq(binding.executionAsyncResource(binding.async_hook_fields[c.kStackLength]-1),promise)});
  reject(reason);assertEq(internalHooks.executionAsyncId(),0);promise.catch(()=>{});rejectionQueue.runMicrotasks();assertEq(events.join(','),'0,1');assertEq(binding.async_hook_fields[c.kStackLength],0);rejectionQueue.setPromiseRejectCallback(()=>{});
});
