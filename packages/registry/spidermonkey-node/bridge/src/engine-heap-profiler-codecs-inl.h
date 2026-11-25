#ifndef KANDELO_ENGINE_HEAP_PROFILER_CODECS_INL_H
#define KANDELO_ENGINE_HEAP_PROFILER_CODECS_INL_H
#include "kandelo-node/engine-heap-profiler-data.h"
#include "js/Wrapper.h"
#include "gc/Cell.h"
#include "kandelo-node/heap-profiler-upstream/deps/v8/src/profiler/heap-profiler.cc"
namespace v8 {
void RetireNativeHeapProfiler(State& state){
  state.AssertForeground();if(state.heapProfiler){state.heapProfiler->Shutdown();state.heapProfiler.reset();}
}
HeapProfiler* Isolate::GetHeapProfiler(){
  auto state=owner.lock();CHECK(state);state->AssertForeground();
  try {
    if(!state->heapProfiler)state->heapProfiler=std::make_shared<internal::HeapProfiler>(state);
    state->heapProfiler->AssertLive();return reinterpret_cast<HeapProfiler*>(state->heapProfiler.get());
  }catch(const std::bad_alloc&){bridge::FatalOutOfMemory(this,"Heap profiler creation",false);}
}
void HeapProfiler::AddBuildEmbedderGraphCallback(BuildEmbedderGraphCallback callback,void* data){
  auto& profiler=*reinterpret_cast<internal::HeapProfiler*>(this);profiler.AssertLive();CHECK(callback);
  try{profiler.AddBuildEmbedderGraphCallback(callback,data);}
  catch(const std::bad_alloc&){bridge::FatalOutOfMemory(profiler.isolate,"Heap graph callback registry",false);}
}
void HeapProfiler::RemoveBuildEmbedderGraphCallback(BuildEmbedderGraphCallback callback,void* data){
  auto& profiler=*reinterpret_cast<internal::HeapProfiler*>(this);profiler.AssertLive();
  profiler.RemoveBuildEmbedderGraphCallback(callback,data);
}
namespace {
struct NativeHeapQueryRoots {
  JS::RootedObjectVector objects;
  bool failed=false;
  explicit NativeHeapQueryRoots(JSContext* cx):objects(cx){}
};
// This visitor consumes cells only; the engine requires all four callbacks.
void NativeHeapQueryZone(JSRuntime*,void*,JS::Zone*,const JS::AutoRequireNoGC&){}
void NativeHeapQueryRealm(JSContext*,void*,JS::Realm*,const JS::AutoRequireNoGC&){}
void NativeHeapQueryArena(JSRuntime*,void*,js::gc::Arena*,JS::TraceKind,size_t,const JS::AutoRequireNoGC&){}
void GatherNativeHeapQueryObject(JSRuntime*,void* raw,JS::GCCellPtr cell,size_t,const JS::AutoRequireNoGC&){
  auto& query=*static_cast<NativeHeapQueryRoots*>(raw);
  if(query.failed||cell.kind()!=JS::TraceKind::Object)return;
  auto* object=&cell.as<JSObject>();
  // Cross-compartment wrappers are transport aliases of the same object, not
  // extra query results. User proxies remain real, distinct JS objects.
  if(JS::GetClass(object)==&nativeExternalClass||js::IsCrossCompartmentWrapper(object)||JS_IsDeadWrapper(object))return;
  // The iterator explicitly supplies unbarriered cells. Perform the real read
  // barrier before retaining the pointer beyond this callback in a GC root.
  js::gc::ReadBarrier(object);
  if(!query.objects.append(object))query.failed=true;
}
}
void HeapProfiler::QueryObjects(Local<Context> context,QueryObjectPredicate* predicate,
    std::vector<Global<Object>>* objects){
  auto& profiler=*reinterpret_cast<internal::HeapProfiler*>(this);profiler.AssertLive();
  CHECK(!context.IsEmpty()&&context->isolate==profiler.isolate&&predicate&&objects);
  auto state=profiler.owner.lock();CHECK(state);auto retained=state->heapProfiler;CHECK(retained.get()==&profiler);
  auto& frame=Current(profiler.isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return;
  Context::Scope home(context);
  try {
    NativeHeapQueryRoots query(frame.cx);
    {
      PreserveNativeFailure preserve(frame.cx);
      Isolate::DisallowJavascriptExecutionScope noJavascript(profiler.isolate,Isolate::DisallowJavascriptExecutionScope::CRASH_ON_FAILURE);
      // SpiderMonkey has no V8 feedback-vector or on-heap TypedArray buffer
      // representation to rewrite before this genuine full-heap collection.
      JS::PrepareForFullGC(frame.cx);
      JS::NonIncrementalGC(frame.cx,JS::GCOptions::Normal,JS::GCReason::API);
      if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return;
      js::gc::AutoTraceSession tracing(frame.cx->runtime());
      js::IterateHeapUnbarriered(frame.cx,&query,NativeHeapQueryZone,NativeHeapQueryRealm,
          NativeHeapQueryArena,GatherNativeHeapQueryObject,tracing);
    }
    if(query.failed)bridge::FatalOutOfMemory(profiler.isolate,"Heap query object roots",false);
    for(size_t i=0;i<query.objects.length();++i){
      HandleScope scope(profiler.isolate);
      JS::RootedValue value(frame.cx,JS::ObjectValue(*query.objects[i]));
      auto object=frame.Own<Object>(value);
      const bool matches=predicate->Filter(object);
      if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return;
      if(matches)objects->emplace_back(profiler.isolate,object);
    }
  }catch(const std::bad_alloc&){bridge::FatalOutOfMemory(&state->isolate,"Heap query result storage",false);}
}
}
#endif
