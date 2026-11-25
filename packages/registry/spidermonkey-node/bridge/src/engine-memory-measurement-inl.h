#ifndef KANDELO_ENGINE_MEMORY_MEASUREMENT_INL_H
#define KANDELO_ENGINE_MEMORY_MEASUREMENT_INL_H
namespace v8 {
// Only the engine census is adapted. The complete upstream default delegate
// retains security-token selection, summary/detail construction and resolution.
struct NativeMemoryMeasurements:std::enable_shared_from_this<NativeMemoryMeasurements> {
  struct Request {
    std::unique_ptr<MeasureMemoryDelegate> delegate;
    std::vector<Global<Object>> contexts;
    bool ready=false;
  };
  std::weak_ptr<State> owner;
  std::shared_ptr<TaskRunner> runner;
  std::list<Request> pending;
  bool closed=false;
  NativeMemoryMeasurements(const std::shared_ptr<State>& state):owner(state),
      runner(V8::GetCurrentPlatform()->GetForegroundTaskRunner(&state->isolate,TaskPriority::kUserVisible)){}
  struct Delivery:Task {
    std::weak_ptr<NativeMemoryMeasurements> owner;bool collect;
    Delivery(const std::shared_ptr<NativeMemoryMeasurements>& input,bool gc):owner(input),collect(gc){}
    void Run()override{if(auto queue=owner.lock())queue->Run(collect);}
  };
  void Post(bool collect,std::optional<double> delay={}){
    CHECK(!closed&&runner);auto task=std::make_unique<Delivery>(shared_from_this(),collect);
    if(delay)runner->PostNonNestableDelayedTask(std::move(task),*delay);
    else runner->PostNonNestableTask(std::move(task));
  }
  void AfterGC(){
    if(closed||pending.empty())return;
    bool post=false;for(auto& request:pending)if(!request.ready){request.ready=true;post=true;}
    if(post)Post(false);
  }
  void Shutdown(){
    if(closed)return;closed=true;pending.clear();runner.reset();owner.reset();
  }
  void Run(bool collect){
    if(closed)return;auto state=owner.lock();CHECK(state);state->AssertForeground();
    if(state->cx->isNativeExecutionTerminating()||JS_IsExceptionPending(state->cx))return;
    if(collect){
      bool needed=false;for(auto& request:pending)needed|=!request.ready;
      if(!needed)return;
      // Equivalent engine operation to V8's queued full-heap measurement GC.
      // Native GC callbacks only enqueue reporting; they never resolve here.
      PreserveNativeFailure failure(state->cx);
      Isolate::DisallowJavascriptExecutionScope noJavascript(&state->isolate,Isolate::DisallowJavascriptExecutionScope::CRASH_ON_FAILURE);
      JS::PrepareForFullGC(state->cx);
      JS::NonIncrementalGC(state->cx,JS::GCOptions::Normal,JS::GCReason::API);
      return;
    }
    // Freeze this reporting batch before delegate resolution can reenter and
    // enqueue another request. New requests need a later GC/census of their own.
    std::list<Request> ready;
    for(auto it=pending.begin();it!=pending.end();){
      auto current=it++;
      if(current->ready)ready.splice(ready.end(),pending,current);
    }
    if(ready.empty())return;
    JSContext* cx=state->cx;
    JS::RootedObject home(cx,state->externalPressureOwner->get());JSAutoRealm realm(cx,home);
    Frame frame(cx,home,state);Isolate::Scope isolate(&state->isolate);HandleScope handles(&state->isolate);
    NativeCallbackEntry entry(*state);
    // Evacuate only the nursery before the actual native realm census. The
    // major GC that marked requests ready has already determined reachability.
    cx->runtime()->gc.evictNursery();
    HeapRuntimeMeasurement measured;
    if(!JS::CollectRuntimeStats(cx,&measured,nullptr,true))
      bridge::FatalOutOfMemory(&state->isolate,"Context memory measurement",true);
    std::map<JS::Realm*,size_t> sizes;
    size_t realmTotal=0;
    for(const auto& row:measured.realmStatsVector){
      JS::RealmStats total;total.addSizes(row);
      for(const auto& notable:row.notableClasses)total.classInfo.add(notable);
      JS::ServoSizes bytes;total.addToServoSizes(&bytes);
      size_t used=bytes.gcHeapUsed;HeapAdd(used,bytes.mallocHeap);
      sizes.emplace(static_cast<JS::Realm*>(row.extra),used);HeapAdd(realmTotal,used);
    }
    JS::ServoSizes bytes;measured.addToServoSizes(&bytes);
    measured.zTotals.addToServoSizes(&bytes);measured.realmTotals.addToServoSizes(&bytes);
    for(const auto& source:measured.runtime.notableScriptSources)source.addToServoSizes(&bytes);
    // GC-buffer cell storage is already in gcHeapUsed. Per-object NonHeap
    // slot/element credits must not be counted again. Realm-owned malloc
    // payloads remain attributed; zone/runtime allocations form the range.
    size_t total=bytes.gcHeapUsed;HeapAdd(total,bytes.mallocHeap);
    const auto& code=measured.zTotals.code;
    for(size_t amount:{code.ion,code.baseline,code.regexp,code.other})HeapAdd(total,amount);
    CHECK_GE(total,realmTotal);const size_t shared=total-realmTotal;
    const size_t wasmCode=measured.realmTotals.classInfo.objectsNonHeapCodeWasm;
    const size_t wasmMetadata=measured.runtime.wasmRuntime;
    struct Report {
      std::unique_ptr<MeasureMemoryDelegate> delegate;
      std::vector<Local<Context>> contexts;
      std::vector<size_t> amounts;
    };
    std::vector<Report> reports;reports.reserve(ready.size());
    // Root all surviving contexts and copy all estimates before resolving any
    // promise. JS/GC during resolution cannot recycle a later realm pointer.
    for(auto& request:ready){
      Report report{std::move(request.delegate),{}, {}};
      for(auto& weak:request.contexts){
        if(weak.IsEmpty())continue;
        JS::RootedObject global(cx,UnwrapObject(cx,Input(weak.Get(&state->isolate))));
        if(!global)continue;auto found=sizes.find(JS::GetObjectRealmOrNull(global));
        if(found==sizes.end())continue;
        report.contexts.push_back(frame.OwnContext(global));report.amounts.push_back(found->second);
      }
      reports.push_back(std::move(report));
    }
    for(auto& report:reports){
      const MemorySpan<const Local<Context>> contextSpan(report.contexts);
      const MemorySpan<const size_t> sizeSpan(report.amounts);
      report.delegate->MeasurementComplete({contextSpan,sizeSpan,shared,wasmCode,wasmMetadata});
      if(cx->isNativeExecutionTerminating()||JS_IsExceptionPending(cx))break;
    }
  }
};
void OnNativeMemoryGC(State& state){
  if(state.memoryMeasurements)state.memoryMeasurements->AfterGC();
}
void RetireNativeMemoryMeasurements(State& state){
  if(state.memoryMeasurements){state.memoryMeasurements->Shutdown();state.memoryMeasurements.reset();}
}
bool Isolate::MeasureMemory(std::unique_ptr<MeasureMemoryDelegate> delegate,MeasureMemoryExecution execution){
  CHECK(delegate);auto& frame=Current(this);auto state=owner.lock();CHECK(state);state->AssertForeground();
  if(state->cx->isNativeExecutionTerminating())return false;
  CHECK(execution==MeasureMemoryExecution::kDefault||execution==MeasureMemoryExecution::kEager||execution==MeasureMemoryExecution::kLazy);
  try {
    if(!state->memoryMeasurements)state->memoryMeasurements=std::make_shared<NativeMemoryMeasurements>(state);
    auto queue=state->memoryMeasurements;CHECK(!queue->closed);
    NativeMemoryMeasurements::Request request;request.delegate=std::move(delegate);
    // Root the current native context list before delegate calls can allocate.
    JS::RootedObjectVector globals(frame.cx);
    for(js::RealmsIter realm(frame.cx->runtime());!realm.done();realm.next()){
      auto* global=JS::GetRealmGlobalOrNull(realm);
      if(global&&JS::GetClass(global)==&nativeNodeGlobalClass&&!globals.append(global))return false;
    }
    for(size_t i=0;i<globals.length();++i){
      JS::RootedObject global(frame.cx,globals[i]);auto context=frame.OwnContext(global);
      if(!request.delegate->ShouldMeasure(context))continue;
      JS::RootedValue value(frame.cx,JS::ObjectValue(*global));
      Global<Object> weak(this,frame.Own<Object>(value));weak.SetWeak();request.contexts.push_back(std::move(weak));
    }
    queue->pending.push_back(std::move(request));
    if(execution==MeasureMemoryExecution::kEager)queue->Post(true);
    else if(execution==MeasureMemoryExecution::kDefault)queue->Post(true,10.0+double(GetHashSeed()%10));
    return true;
  }catch(const std::bad_alloc&){JS_ReportOutOfMemory(frame.cx);return false;}
}
}
#endif
