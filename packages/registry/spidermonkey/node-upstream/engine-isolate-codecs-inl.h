#ifndef KANDELO_ENGINE_ISOLATE_CODECS_INL_H
#define KANDELO_ENGINE_ISOLATE_CODECS_INL_H

#include "js/Promise.h"
#include "js/MemoryCallbacks.h"
#include "gc/PublicIterators.h"
#include "v8-platform.h"

namespace v8 {
void InitializeNativeCodeGeneration(State&);
void RetireNativeCodeGeneration(State&);
struct NativeAsyncDelivery {
  js::UniquePtr<JS::Dispatchable> task;
  std::list<std::shared_ptr<NativeAsyncDelivery>>::iterator position;
  bool pending=false;
};
// The original Node TaskRunner owns scheduling, ordering, wakeups and delayed
// timers. This ledger owns only SpiderMonkey's accepted Dispatchables so that
// Node discarding a queued Task cannot strand engine roots during shutdown.
struct NativeEngineAsyncTasks:std::enable_shared_from_this<NativeEngineAsyncTasks> {
  std::mutex mutex;
  JSContext* cx;
  const std::thread::id foreground=std::this_thread::get_id();
  std::shared_ptr<TaskRunner> runner;
  std::list<std::shared_ptr<NativeAsyncDelivery>> pending;
  bool accepting=true;
  explicit NativeEngineAsyncTasks(JSContext* context,std::shared_ptr<TaskRunner> input)
      :cx(context),runner(std::move(input)){CHECK(cx&&runner&&runner->NonNestableTasksEnabled()&&runner->NonNestableDelayedTasksEnabled());}
  ~NativeEngineAsyncTasks(){CHECK(!cx&&!accepting&&pending.empty()&&!runner);}
  void AssertForeground()const{CHECK(foreground==std::this_thread::get_id());}
  struct Delivery final:Task {
    std::shared_ptr<NativeEngineAsyncTasks> owner;
    std::shared_ptr<NativeAsyncDelivery> record;
    Delivery(std::shared_ptr<NativeEngineAsyncTasks> input,std::shared_ptr<NativeAsyncDelivery> task)
        :owner(std::move(input)),record(std::move(task)){}
    void Run()override{owner->Run(record);}
  };
  bool Post(js::UniquePtr<JS::Dispatchable>&& task,std::optional<uint32_t> delay){
    CHECK(task);
    // The engine may hold its helper-thread lock while calling us. Never enter
    // SpiderMonkey or release a registered task under this mutex. Its original
    // foreground runner only enqueues; it never executes this Task inline.
    std::unique_lock lock(mutex);
    if(!accepting){
      lock.unlock();JS::Dispatchable::ReleaseFailedTask(std::move(task));return false;
    }
    try {
      // Allocate every ledger node before taking the engine task. Allocation
      // failure must never destroy a registered Dispatchable on this producer.
      auto record=std::make_shared<NativeAsyncDelivery>();
      auto delivery=std::make_unique<Delivery>(shared_from_this(),record);
      record->position=pending.insert(pending.end(),record);record->pending=true;
      record->task=std::move(task);
      if(delay)runner->PostNonNestableDelayedTask(std::move(delivery),double(*delay)/1000.0);
      else runner->PostNonNestableTask(std::move(delivery));
      return true;
    }catch(const std::bad_alloc&){
      // Returning false means permanent shutdown, not a recoverable allocation
      // failure. Keep the same fatal-OOM policy as an infallible engine enqueue.
      Crash("Native asynchronous task dispatch allocation failed");
    }
  }
  static bool Dispatch(void* raw,js::UniquePtr<JS::Dispatchable>&& task){
    return static_cast<NativeEngineAsyncTasks*>(raw)->Post(std::move(task),std::nullopt);
  }
  static bool DispatchDelayed(void* raw,js::UniquePtr<JS::Dispatchable>&& task,uint32_t delay){
    return static_cast<NativeEngineAsyncTasks*>(raw)->Post(std::move(task),delay);
  }
  void Run(const std::shared_ptr<NativeAsyncDelivery>& record){
    AssertForeground();js::UniquePtr<JS::Dispatchable> task;
    {
      std::lock_guard lock(mutex);
      // Closed-context Task wrappers contain no engine roots. They may be
      // discarded or invoked after Deinitialize, before platform unregister.
      if(!record->pending){CHECK(!record->task);return;}
      CHECK(accepting&&cx&&cx==js::TlsContext.get());
      pending.erase(record->position);record->pending=false;task=std::move(record->task);
    }
    JS::Dispatchable::Run(cx,std::move(task),JS::Dispatchable::NotShuttingDown);
  }
  void Shutdown(){
    AssertForeground();CHECK(cx&&cx==js::TlsContext.get());
    {
      std::lock_guard lock(mutex);CHECK(accepting);accepting=false;
    }
    // Cancel undispatched cancellable work first. In particular this disables
    // waitAsync timeout entries without resolving any user promise. Background
    // producers now return rejected deliveries to SpiderMonkey's failed list.
    JS::CancelAsyncTasks(cx);
    for(;;){
      js::UniquePtr<JS::Dispatchable> task;
      {
        std::lock_guard lock(mutex);if(pending.empty())break;
        auto record=pending.front();pending.pop_front();record->pending=false;
        task=std::move(record->task);
      }
      JS::Dispatchable::Run(cx,std::move(task),JS::Dispatchable::ShuttingDown);
    }
    // All accepted entries have actually run with ShuttingDown. The real
    // engine barrier waits for non-cancellable producers and deletes rejected
    // entries on this thread. It is never replaced by a queue-empty assertion.
    JS::ShutdownAsyncTasks(cx);
    std::lock_guard lock(mutex);cx=nullptr;runner.reset();
  }
};
struct NativeFinalizationRecord {
  JS::PersistentRootedObject function;
  NativeFinalizationRecord(JSContext* cx,JSFunction* input):function(cx,input){}
};
// Own only the engine's queued cleanup roots and delivery admission. Original
// Node TaskRunner supplies scheduling/liveness; the real SM queue owns records,
// weak registry death, unregister behavior and user callback execution.
struct NativeFinalizationTasks:std::enable_shared_from_this<NativeFinalizationTasks> {
  Isolate* const isolate;
  JSContext* cx;
  const std::thread::id foreground=std::this_thread::get_id();
  std::shared_ptr<TaskRunner> runner;
  std::weak_ptr<State> state;
  std::list<std::unique_ptr<NativeFinalizationRecord>> pending;
  std::atomic<uint64_t> postedTicket{0};
  uint64_t nextTicket=0;
  bool accepting=true,running=false;
  NativeFinalizationTasks(Isolate*,std::shared_ptr<TaskRunner>);
  ~NativeFinalizationTasks();
  void AssertForeground()const;
  struct Delivery final:Task {
    std::shared_ptr<NativeFinalizationTasks> owner;
    const uint64_t ticket;
    Delivery(std::shared_ptr<NativeFinalizationTasks> input,uint64_t id)
        :owner(std::move(input)),ticket(id){}
    ~Delivery()override{owner->Discard(ticket);}
    void Run()override{owner->Discard(ticket);owner->Run();}
  };
  void Discard(uint64_t ticket){postedTicket.compare_exchange_strong(ticket,0);}
  static void Notify(JSFunction*,JSObject*,void*);
  void Post(JSFunction*);
  void PostNext(bool allowBlocked=false);
  void Run();
  void Shutdown();
};
enum class NativeIsolatePhase {Allocated,Initializing,Live,Closing,Closed};
struct NativeGcCallbackRecord {
  Isolate::GCCallback callback=nullptr;
  Isolate::GCCallbackWithData callbackWithData=nullptr;
  void* data=nullptr;
  GCType filter=kGCTypeAll;
  bool active=true;
};
struct NativeIsolateData {
  NativeIsolatePhase phase=NativeIsolatePhase::Allocated;
  std::thread::id foreground;
  JSContext* cx=nullptr;
  std::shared_ptr<State> state;
  bool registered=false;
  std::unique_ptr<CppHeap> cppHeap;
  std::shared_ptr<NativeEngineAsyncTasks> asyncTasks;
  std::shared_ptr<NativeFinalizationTasks> finalizationTasks;
  std::shared_ptr<ArrayBuffer::Allocator> sharedAllocator;
  ArrayBuffer::Allocator* allocator=nullptr;
  ResourceConstraints constraints;
  // Own the original null-terminated embedder table independently of the
  // caller's input buffer. It adds no JS roots or snapshot-restoration support.
  std::vector<intptr_t> externalReferences;
  FatalErrorCallback fatalHandler=nullptr;
  OOMErrorCallback oomHandler=nullptr;
  bool reportingFatal=false;
  PrepareStackTraceCallback prepareStackTrace=nullptr;
  Isolate::AbortOnUncaughtExceptionCallback abortOnUncaught=nullptr;
  FunctionCallback wasmStreaming=nullptr;
  HostCreateShadowRealmContextCallback createShadowRealm=nullptr;
  std::atomic<bool> idle{true};
  bool captureUncaughtStacks=false;
  int uncaughtStackFrameLimit=10;
  StackTrace::StackTraceOptions uncaughtStackOptions=StackTrace::kOverview;
  std::vector<std::pair<NearHeapLimitCallback,void*>> nearHeapCallbacks;
  std::vector<std::shared_ptr<NativeGcCallbackRecord>> gcPrologues,gcEpilogues;
  size_t initialCellHeapLimit=0;
  double restoreCellHeapThreshold=0;
  unsigned gcCallbackDepth=0;
  GCCallbackFlags explicitGcFlags=kNoGCCallbackFlags;
  bool memoryServicesInstalled=false;
  std::unique_ptr<MicrotaskQueue> microtasks;
  std::vector<std::pair<MessageCallback,int>> messageListeners;
  void AssertForeground()const{CHECK(foreground==std::this_thread::get_id());}
};
// The real collector owns its pressure thresholds and collection scheduling.
// The bridge supplies only balanced native credits and marks all zones when
// these Isolate-wide credits cause a collection request.
const JSClass nativeExternalPressureClass={"NodeExternalMemory",JSCLASS_GLOBAL_FLAGS,&JS::DefaultGlobalClassOps};
void SyncNativeExternalPressure(State& state){
  state.AssertForeground();if(!state.externalPressureOwner||JS::RuntimeHeapIsBusy())return;
  const size_t target=size_t(std::min(state.nativeExternalCredits.load(),uint64_t(SIZE_MAX)));
  const size_t previous=state.externalPressureBytes;
  state.externalPressureBytes=target;
  if(target>previous){
    JS::AddAssociatedMemory(state.externalPressureOwner->get(),target-previous,JS::MemoryUse::Embedding1);
    if(state.cx->runtime()->gc.majorGCRequested())JS::PrepareForFullGC(state.cx);
  }else if(target<previous)
    JS::RemoveAssociatedMemory(state.externalPressureOwner->get(),previous-target,JS::MemoryUse::Embedding1);
}
int64_t AdjustNativeExternalCredit(State& state,int64_t delta){
  uint64_t previous=state.nativeExternalCredits.load(),next;
  do {
    if(delta>=0){CHECK_LE(uint64_t(delta),uint64_t(INT64_MAX)-previous);next=previous+uint64_t(delta);}
    else {const uint64_t bytes=uint64_t(-(delta+1))+1;CHECK_GE(previous,bytes);next=previous-bytes;}
  }while(!state.nativeExternalCredits.compare_exchange_weak(previous,next));
  // Background finalizers only update the balance. The next foreground credit
  // or GC epilogue reconciles it, without touching roots on a sweep thread.
  if(state.IsForeground())SyncNativeExternalPressure(state);
  return int64_t(next);
}
int64_t Isolate::AdjustAmountOfExternalAllocatedMemory(int64_t delta){
  bridge::CheckExternalMemoryDelta(delta);auto state=owner.lock();CHECK(state);state->AssertForeground();
  return AdjustNativeExternalCredit(*state,delta);
}
#include "shell/node-upstream/engine-memory-services-inl.h"
namespace bridge {
void CallFatalErrorHandler(const char* message){
  auto* isolate=Isolate::TryGetCurrent();
  if(!isolate||!isolate->native_)return;
  auto& data=*isolate->native_;
  if(!data.fatalHandler||data.reportingFatal)return;
  data.AssertForeground();data.reportingFatal=true;
  std::optional<Isolate::DisallowJavascriptExecutionScope> noJavascript;
  if(isolate->owner.lock())noJavascript.emplace(isolate,Isolate::DisallowJavascriptExecutionScope::CRASH_ON_FAILURE);
  data.fatalHandler("Kandelo SpiderMonkey bridge",message);
  // Original Node's handler aborts. A returning embedder handler cannot turn
  // this fatal API failure into a successful engine operation.
}
[[noreturn]] void FatalOutOfMemory(Isolate* isolate,const char* location,bool heap){
  if(isolate&&isolate->native_){
    auto& data=*isolate->native_;data.AssertForeground();
    if(data.oomHandler&&!data.reportingFatal){
      data.reportingFatal=true;
      std::optional<Isolate::DisallowJavascriptExecutionScope> noJavascript;
      if(isolate->owner.lock())noJavascript.emplace(isolate,Isolate::DisallowJavascriptExecutionScope::CRASH_ON_FAILURE);
      data.oomHandler(location,OOMDetails{heap,nullptr});
    }
  }
  kandelo_v8_graceful_fatal(location);
}
}
namespace {
void NativeEngineOutOfMemory(JSContext*,void* raw){
  bridge::FatalOutOfMemory(static_cast<Isolate*>(raw),"SpiderMonkey engine allocation",true);
}
class NativeDefaultArrayAllocator final:public ArrayBuffer::Allocator {
 public:
  void* Allocate(size_t bytes)override{return std::calloc(std::max(bytes,size_t(1)),1);}
  void* AllocateUninitialized(size_t bytes)override{return std::malloc(std::max(bytes,size_t(1)));}
  void Free(void* memory,size_t)override{std::free(memory);}
};
// The guest's one actual address space is shared by its pthreads. No V8
// pointer-compression cages or extra virtual-memory reservation are imported.
const unsigned char processAddressSpace=0;
}
IsolateGroup IsolateGroup::GetDefault(){return IsolateGroup(&processAddressSpace);}
IsolateGroup IsolateGroup::Create(){Crash("This guest has one isolate address-space group");}
ArrayBuffer::Allocator* ArrayBuffer::Allocator::NewDefaultAllocator(){return new NativeDefaultArrayAllocator;}
Isolate* Isolate::Allocate(){return Allocate(IsolateGroup::GetDefault());}
Isolate* Isolate::Allocate(const IsolateGroup& group){
  CHECK(group==IsolateGroup::GetDefault());
  auto* isolate=new(std::nothrow) Isolate;if(!isolate)return nullptr;
  try {isolate->native_=std::make_shared<NativeIsolateData>();}
  catch(const std::bad_alloc&){delete isolate;return nullptr;}
  // Node must register this stable address on its platform before Initialize.
  return isolate;
}
void ResourceConstraints::ConfigureDefaults(uint64_t physicalMemory,uint64_t virtualLimit){
  // SpiderMonkey's enforced cell cap and native nursery default are the
  // backend defaults. Bound them by real limits supplied by the OS; zero
  // physical capacity from libuv means unknown, not a measured empty machine.
  uint64_t cap=UINT32_MAX;
  if(physicalMemory)cap=std::min(cap,physicalMemory);
  if(virtualLimit)cap=std::min(cap,virtualLimit);
  CHECK(cap>0);
  maxOld_=size_t(cap);
  maxYoung_=std::min(size_t(JS::DefaultNurseryMaxBytes),maxOld_);
  // This engine build has no native JIT/code-range reservation.
  codeRange_=0;
}
void Isolate::Initialize(Isolate* isolate,const CreateParams& params){
  CHECK(isolate&&isolate->native_);
  if(params.snapshot_blob)Crash("V8 startup snapshot restoration is unavailable");
  auto& data=*isolate->native_;
  CHECK(data.phase==NativeIsolatePhase::Allocated&&!js::TlsContext.get());
  data.phase=NativeIsolatePhase::Initializing;data.foreground=std::this_thread::get_id();
  data.constraints=params.constraints;data.fatalHandler=params.fatal_error_callback;
  data.oomHandler=params.oom_error_callback;
  data.cppHeap.reset(params.cpp_heap);
  CHECK(!params.array_buffer_allocator_shared||!params.array_buffer_allocator||
        params.array_buffer_allocator_shared.get()==params.array_buffer_allocator);
  const char* failure="Native engine context initialization failed";
  bool initialized=false;
  try {
    if(params.external_references){
      for(const intptr_t* entry=params.external_references;*entry;++entry)
        data.externalReferences.push_back(*entry);
      data.externalReferences.push_back(0);
    }
    data.sharedAllocator=params.array_buffer_allocator_shared;
    data.allocator=data.sharedAllocator?data.sharedAllocator.get():params.array_buffer_allocator;
    if(!data.allocator){
      data.sharedAllocator.reset(ArrayBuffer::Allocator::NewDefaultAllocator());
      data.allocator=data.sharedAllocator.get();
    }
    data.cx=bridge::NewProcessContext();
    if(data.cx){
      // Node can enable Promise hooks after a reaction is registered. Keep
      // ordinary Then result objects available for those later notifications.
      data.cx->embedderPromiseLifecycleCapable=true;
      // These are real cell-heap/nursery caps, not a claim that SpiderMonkey's
      // stock parameters cover Node's full managed heap or near-limit retry.
      auto oldBytes=params.constraints.max_old_generation_size_in_bytes();
      auto youngBytes=params.constraints.max_young_generation_size_in_bytes();
      if(oldBytes)CHECK(data.cx->runtime()->gc.setParameter(data.cx,JSGC_MAX_BYTES,uint32_t(oldBytes)));
      if(youngBytes){
        // A requested ceiling need not enlarge the engine's nursery. Lower
        // its current supported ceiling and check the real fallible setter;
        // JS_SetGCParameter would silently ignore a rejected value.
        youngBytes=std::min(youngBytes,size_t(JS_GetGCParameter(data.cx,JSGC_MAX_NURSERY_BYTES)));
        CHECK(data.cx->runtime()->gc.setParameter(data.cx,JSGC_MAX_NURSERY_BYTES,uint32_t(youngBytes)));
      }
      if(auto* limit=params.constraints.stack_limit()){
        uintptr_t base=data.cx->nativeStackBase();CHECK(uintptr_t(limit)<base);
        JS_SetNativeStackQuota(data.cx,size_t(base-uintptr_t(limit)));
      }
      data.state=std::make_shared<State>(data.cx,isolate);
      if(RegisterNativeEngineState(data.state)){
        data.registered=true;
        InitializeNativeCodeGeneration(*data.state);
        JS::SetOutOfMemoryCallback(data.cx,NativeEngineOutOfMemory,isolate);
        initialized=!data.cppHeap||data.cppHeap->AttachToIsolate(isolate);
        if(initialized){
          JS::RealmOptions pressureOptions;pressureOptions.creationOptions().setInvisibleToDebugger(true);
          JS::RootedObject pressureOwner(data.cx,JS_NewGlobalObject(data.cx,&nativeExternalPressureClass,nullptr,JS::FireOnNewGlobalHook,pressureOptions));
          if(!pressureOwner)bridge::FatalOutOfMemory(isolate,"External memory pressure owner",true);
          data.state->externalPressureOwner=std::make_unique<JS::PersistentRootedObject>(data.cx,pressureOwner);
          NativeMemoryServices::Initialize(isolate);
          data.microtasks.reset(new MicrotaskQueue(isolate));
          data.state->microtasks=data.microtasks.get();
          auto* platform=V8::GetCurrentPlatform();CHECK(platform);
          auto runner=platform->GetForegroundTaskRunner(isolate,TaskPriority::kUserBlocking);
          data.finalizationTasks=std::make_shared<NativeFinalizationTasks>(isolate,runner);
          JS::SetHostCleanupFinalizationRegistryCallback(data.cx,NativeFinalizationTasks::Notify,data.finalizationTasks.get());
          data.asyncTasks=std::make_shared<NativeEngineAsyncTasks>(data.cx,std::move(runner));
          JS::InitAsyncTaskCallbacks(data.cx,NativeEngineAsyncTasks::Dispatch,
              NativeEngineAsyncTasks::DispatchDelayed,nullptr,nullptr,data.asyncTasks.get());
        }
      }
    }
  }catch(const std::bad_alloc&){initialized=false;failure="Native engine context initialization allocation failed";}
  if(!initialized){isolate->Deinitialize();Crash(failure);}
  data.phase=NativeIsolatePhase::Live;
  // This establishes physical context/owner storage only. Original Node's
  // handler setup and the remaining constraint/realm APIs must be bound
  // before it can bootstrap JS; the package remains an incomplete Node SDK.
}
void Isolate::SetCaptureStackTraceForUncaughtExceptions(bool capture,int limit,StackTrace::StackTraceOptions options){
  CHECK(native_);auto& data=*native_;CHECK_GE(limit,0);
  CHECK_EQ(int(options)&~int(StackTrace::kDetailed|StackTrace::kExposeFramesAcrossSecurityOrigins),0);
  if(data.cx){data.AssertForeground();CHECK(data.cx==js::TlsContext.get());}
  data.captureUncaughtStacks=capture;data.uncaughtStackFrameLimit=limit;data.uncaughtStackOptions=options;
  // SpiderMonkey otherwise stops retaining primitive throw stacks after a
  // heuristic quota. Node's explicit capture setting must keep every throw.
  if(data.cx)for(js::RealmsIter realm(data.cx->runtime());!realm.done();realm.next())
    bridge::ApplyUncaughtStackCapture(this,realm);
}
namespace bridge {
void ApplyUncaughtStackCapture(Isolate* isolate,JS::Realm* realm){
  CHECK(isolate&&isolate->native_&&realm);auto& data=*isolate->native_;
  data.AssertForeground();CHECK(data.cx==js::TlsContext.get());
  realm->isUnlimitedStacksCapturingEnabled=data.captureUncaughtStacks;
}
int UncaughtStackFrameLimit(Isolate* isolate){
  CHECK(isolate&&isolate->native_);auto& data=*isolate->native_;data.AssertForeground();
  return data.captureUncaughtStacks?data.uncaughtStackFrameLimit:-1;
}
}
void Isolate::SetAbortOnUncaughtExceptionCallback(AbortOnUncaughtExceptionCallback callback){
  CHECK(native_);native_->AssertForeground();CHECK(native_->phase==NativeIsolatePhase::Live);
  native_->abortOnUncaught=callback;
}
void Isolate::SetWasmStreamingCallback(FunctionCallback callback){
  CHECK(native_);native_->AssertForeground();CHECK(native_->phase==NativeIsolatePhase::Live);
  // Preserve the original native registration. Actual streaming creation is
  // rejected at the separately selected general-Wasm boundary.
  native_->wasmStreaming=callback;
}
void Isolate::SetHostCreateShadowRealmContextCallback(HostCreateShadowRealmContextCallback callback){
  CHECK(native_);native_->AssertForeground();CHECK(native_->phase==NativeIsolatePhase::Live);
  native_->createShadowRealm=callback;
}
void Isolate::SetIdle(bool idle){
  CHECK(native_);native_->AssertForeground();CHECK(native_->phase==NativeIsolatePhase::Live);
  // V8 leaves the running-JavaScript state alone. Only native/loop transitions
  // change the embedder idle record, which is safe for an engine sampler.
  if(native_->cx->activation())return;
  native_->idle.store(idle,std::memory_order_release);
}
void Isolate::SetPrepareStackTraceCallback(PrepareStackTraceCallback callback){
  CHECK(native_);native_->AssertForeground();CHECK(native_->phase==NativeIsolatePhase::Live);
  native_->prepareStackTrace=callback;
}
namespace bridge {
bool PrepareNativeStack(JSContext* cx,JS::HandleValue error,JS::HandleObject trace,bool* handled,JS::MutableHandleValue output){
  auto state=ReadNativeEngineState(cx);CHECK(state&&state->cx==cx);state->AssertForeground();
  auto& isolate=state->isolate;CHECK(isolate.native_);auto callback=isolate.native_->prepareStackTrace;
  *handled=callback!=nullptr;if(!callback)return true;
  JS::RootedObject global(cx,JS::CurrentGlobalOrNull(cx));CHECK(global);
  NativeCallbackEntry entry(*state);Frame frame(cx,global,state);
  JS::RootedValue sites(cx,JS::ObjectValue(*trace));
  auto result=callback(frame.OwnContext(global),frame.OwnValue(error),frame.Own<Array>(sites));
  Local<Value> value;if(!result.ToLocal(&value))return false;
  if(JS_IsExceptionPending(cx)||cx->isNativeExecutionTerminating())return false;
  output.set(Input(value));return JS_WrapValue(cx,output);
}
}
void Isolate::SetFatalErrorHandler(FatalErrorCallback callback){
  CHECK(native_);native_->AssertForeground();CHECK(native_->phase==NativeIsolatePhase::Live);
  native_->fatalHandler=callback;
}
void Isolate::SetOOMErrorHandler(OOMErrorCallback callback){
  CHECK(native_);native_->AssertForeground();CHECK(native_->phase==NativeIsolatePhase::Live);
  native_->oomHandler=callback;
}
ArrayBuffer::Allocator* Isolate::GetArrayBufferAllocator(){
  CHECK(native_&&(native_->phase==NativeIsolatePhase::Live||native_->phase==NativeIsolatePhase::Closing));
  native_->AssertForeground();CHECK(native_->allocator);return native_->allocator;
}
std::shared_ptr<ArrayBuffer::Allocator> Isolate::GetArrayBufferAllocatorShared(){
  CHECK(native_&&(native_->phase==NativeIsolatePhase::Live||native_->phase==NativeIsolatePhase::Closing));
  native_->AssertForeground();return native_->sharedAllocator;
}
void Isolate::SetStackLimit(uintptr_t limit){
  auto state=owner.lock();CHECK(state&&state->cx==js::TlsContext.get());state->AssertForeground();
  uintptr_t base=state->cx->nativeStackBase();CHECK(limit<base);
  JS_SetNativeStackQuota(state->cx,size_t(base-limit));
}
void Isolate::Deinitialize(){
  CHECK(native_);auto& data=*native_;data.AssertForeground();
  if(data.phase==NativeIsolatePhase::Closed)return;
  CHECK(data.phase==NativeIsolatePhase::Initializing||data.phase==NativeIsolatePhase::Live);
  data.phase=NativeIsolatePhase::Closing;
  if(data.cx){
    CHECK(data.cx==js::TlsContext.get());
    CHECK(!data.state||(!data.state->lockerDepth&&!data.state->handleScopeLevel&&
          !data.state->activeHandleScope&&!data.state->activeHandleSeal&&!data.state->sealedHandleLevel));
    NativeMemoryServices::Retire(this);
    if(data.state){
      PreserveNativeFailure preserve(data.cx);
      DisallowJavascriptExecutionScope noJavascript(this,DisallowJavascriptExecutionScope::CRASH_ON_FAILURE);
      RetireNativeHeapProfiler(*data.state);
      RetireNativeCpuProfilers(*data.state);
    }
    for(auto* frame=Frame::current;frame;frame=frame->previous)CHECK(frame->state!=data.state);
    for(auto* scope=IsolateScopeData::current;scope;scope=scope->previous)CHECK(scope->owner!=data.state);
    // Close dispatch admission and retire accepted deliveries before the real
    // engine cancellation/wait barrier, while all context roots still exist.
    if(data.registered){
      {
        PreserveNativeFailure preserve(data.cx);
        DisallowJavascriptExecutionScope noJavascript(this,DisallowJavascriptExecutionScope::CRASH_ON_FAILURE);
        JS::SetHostCleanupFinalizationRegistryCallback(data.cx,nullptr,nullptr);
        RetireNativeCodeGeneration(*data.state);
        JS::SetEmbeddingErrorStackHooks(JS_GetRuntime(data.cx),nullptr,nullptr);
        data.prepareStackTrace=nullptr;data.abortOnUncaught=nullptr;
        data.wasmStreaming=nullptr;data.createShadowRealm=nullptr;
        if(data.finalizationTasks){data.finalizationTasks->Shutdown();data.finalizationTasks.reset();}
        if(data.asyncTasks){data.asyncTasks->Shutdown();data.asyncTasks.reset();}
        else JS::ShutdownAsyncTasks(data.cx);
        DrainNativeInterruptsForCleanup();
        RetireNativeMemoryMeasurements(*data.state);
        if(data.cppHeap&&data.state->cppHeap)data.cppHeap->Terminate();
        data.cppHeap.reset();
        if(data.microtasks)data.microtasks->RetireNativeMicrotasks();
        data.state->microtasks=nullptr;data.state->templateRealm.reset();
        if(data.state->externalPressureBytes){
          JS::RemoveAssociatedMemory(data.state->externalPressureOwner->get(),data.state->externalPressureBytes,JS::MemoryUse::Embedding1);
          data.state->externalPressureBytes=0;
        }
        data.state->externalPressureOwner.reset();
        JS::SetPromiseRejectionTrackerCallback(data.cx,nullptr,nullptr);
        data.state->promiseRejectCallback=nullptr;
        data.cx->embedderPromiseLifecycleHook=nullptr;
        data.cx->embedderPromiseLifecycleData=nullptr;
        data.state->promiseHook=nullptr;
        RetireNativeEngineState(data.cx);data.registered=false;
      }
    }else {
      JS::ShutdownAsyncTasks(data.cx);data.cppHeap.reset();
      if(data.state)data.state->templateRealm.reset();
    }
    data.state.reset();owner.reset();
    JS::SetOutOfMemoryCallback(data.cx,nullptr,nullptr);
    bridge::DestroyProcessContext(data.cx);data.cx=nullptr;
    data.microtasks.reset();
  }else {data.cppHeap.reset();data.state.reset();owner.reset();}
  data.allocator=nullptr;data.sharedAllocator.reset();data.phase=NativeIsolatePhase::Closed;
  // Address release remains separate: original Node unregisters this address
  // from its platform before Free makes it available to another Isolate.
}
void CheckNativeIsolateReleased(Isolate* isolate){
  if(!isolate->native_)return;
  auto& data=*isolate->native_;
  CHECK(data.phase==NativeIsolatePhase::Allocated||data.phase==NativeIsolatePhase::Closed);
  CHECK(!data.cx&&!data.state&&!data.registered&&!data.cppHeap&&!data.asyncTasks&&!data.finalizationTasks&&!data.microtasks);
  CHECK(!data.memoryServicesInstalled&&!data.gcCallbackDepth&&data.nearHeapCallbacks.empty()&&data.gcPrologues.empty()&&data.gcEpilogues.empty());
}
void Isolate::Free(Isolate* isolate){CHECK(isolate);CheckNativeIsolateReleased(isolate);delete isolate;}
}
#endif
