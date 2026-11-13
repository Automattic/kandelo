// @shared-trace-binding-controls
const sharedCases=observations.length;
check('cached-native-binding-keeps-functions-and-constructor-through-moving-gc',()=>{
  const trace=binding.trace,constructor=binding.CategorySet;collect();
  assert(realm.internalBinding('trace_events')===binding&&binding.trace===trace&&binding.CategorySet===constructor);
  return true;
});
check('realms-have-distinct-functions-and-share-the-real-process-controller',()=>{
  const global=newGlobal({newCompartment:true});api.initializeContext(global);
  const other=api.initializeRealm(global),foreign=other.internalBinding('trace_events');
  assert(foreign!==binding&&foreign.trace!==binding.trace&&foreign.CategorySet!==C);
  const flags=binding.getCategoryEnabledBuffer('engine.foreign'),foreignFlags=foreign.getCategoryEnabledBuffer('engine.foreign');
  const owner=new foreign.CategorySet(['engine.foreign']);owner.enable();
  try{collect();assert(flags[0]>0&&foreignFlags[0]>0);assert(binding.isTraceCategoryEnabled('engine.foreign'));C.prototype.disable.call(owner);assert(flags[0]===0&&foreignFlags[0]===0)}finally{owner.disable()}
  return true;
});
check('source-native-category-owners-finalize-once-after-moving-gc',()=>{
  collect();const before=api.inspectCodecs();
  (()=>{for(let i=0;i<20;i++){const owner=new C([]);owner.enable();owner.disable()}})();
  collect();collect();const after=api.inspectCodecs();
  assert(after.traceCreated-before.traceCreated===20&&after.traceReleased-before.traceReleased===20,JSON.stringify({before,after}));
  return {created:after.traceCreated-before.traceCreated,released:after.traceReleased-before.traceReleased};
});
check('environment-observer-replacement-across-realms-survives-moving-gc',()=>{
  const principal=[],foreignValues=[],global=newGlobal({newCompartment:true});api.initializeContext(global);
  const other=api.initializeRealm(global),foreign=other.internalBinding('trace_events');
  global.values=foreignValues;binding.setTraceCategoryStateUpdateHandler(value=>principal.push(value));
  foreign.setTraceCategoryStateUpdateHandler(global.eval('(value)=>{gc("shrinking");values.push(value)}'));
  collect();const owner=new C(['node.async_hooks']);owner.enable();owner.disable();
  same(principal,[]);same(foreignValues,[false,true,false,false]);
  binding.setTraceCategoryStateUpdateHandler(()=>{});return foreignValues;
});
check('private-test-teardown-cannot-destroy-an-active-source-call',()=>{
  const expected='Native tracing test teardown requires an idle native stack';
  scoped(['engine.guard'],()=>{
    const data={toJSON(){assert(thrown(()=>api.traceAgent('stop')).message===expected);collect();return{alive:true}}};
    assert(binding.trace(105,'engine.guard','guarded-json',undefined,data));
  });
  const values=[];binding.setTraceCategoryStateUpdateHandler(()=>values.push(thrown(()=>api.traceAgent('stop')).message));
  const owner=new C(['node.async_hooks']);owner.enable();owner.disable();binding.setTraceCategoryStateUpdateHandler(()=>{});
  assert(values.length===4&&values.every(value=>value===expected));assert(binding.hasAgent());return true;
});
check('complete-original-internal-tracing-consumer-observes-live-native-state',()=>{
  const original=realm.require('internal/trace_events'),category=original.nodeTraceEventCategory('engine.original');
  assert(original.trace===binding.trace&&original.usePerfetto===false&&category==='node,engine.original');
  const enabled=original.categoryEnabledChecker(category);assert(enabled()===false);
  scoped(['engine.original'],()=>{collect();assert(enabled()===true);assert(original.trace(original.kTraceInstant,category,'original-consumer',undefined,{value:11}))});
  assert(enabled()===false);return true;
});
let bootstrapFailure;
check('failed-realm-retires-callbacks-native-owners-and-environment-observer',()=>{
  const values=[],global=newGlobal({newCompartment:true});api.initializeContext(global);
  const other=api.initializeRealm(global),foreign=other.internalBinding('trace_events');
  const owner=new foreign.CategorySet([]),flags=foreign.getCategoryEnabledBuffer('engine.failed');
  global.values=values;foreign.setTraceCategoryStateUpdateHandler(global.eval('(value)=>values.push(value)'));
  const error=thrown(()=>api.runNodeBootstrap(global));
  bootstrapFailure={name:error.name,code:error.code,message:error.message,stack:error.stack,compiledBuiltinIds:api.inspectRealm(global).compiledBuiltinIds};
  for(const run of[()=>foreign.hasAgent(),()=>foreign.trace(105,'engine.failed','unused'),()=>owner.enable(),()=>C.prototype.enable.call(owner)])assert(thrown(run).message.includes('Previous Node realm initialization failed'));
  scoped(['engine.failed'],()=>{collect();assert(flags[0]>0)});assert(flags[0]===0);same(values,[]);
  binding.setTraceCategoryStateUpdateHandler(()=>{});assert(binding.hasAgent());return true;
});
const traceFile=JSON.parse(api.traceAgent('stop'));
check('explicit-shutdown-retires-native-callbacks',()=>{
  assert(thrown(()=>binding.hasAgent()).message==='Native tracing process has shut down');
  collect();return true;
});
print(JSON.stringify({kind:'native-trace-binding-controls',cases:observations.length,sharedCases,failures,observations,bootstrapFailure,traceFile,upstreamStartup:false}));
if(failures)quit(1);
