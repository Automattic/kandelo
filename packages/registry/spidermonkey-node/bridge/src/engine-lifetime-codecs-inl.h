#ifndef KANDELO_ENGINE_LIFETIME_CODECS_INL_H
#define KANDELO_ENGINE_LIFETIME_CODECS_INL_H
// Engine scopes, persistent roots and native callback transport. Node's real
// Environment and platform retain policy, producer retirement and loop ownership.
namespace v8 {
size_t NewEternalRoot(Isolate* isolate,Local<Data> input){
  auto& frame=Current(isolate);CheckNativePrimitiveAccess(frame);
  CHECK(!input.IsEmpty()&&input->cell().context==frame.cx);
  try {
    auto root=RetainRoot(isolate,input);
    const size_t index=frame.state->eternalRoots.size();
    frame.state->eternalRoots.push_back(std::move(root));return index;
  }catch(const std::bad_alloc&){
    bridge::FatalOutOfMemory(isolate,"Native Eternal root allocation",false);
  }
}
Local<Data> ReadEternalRoot(Isolate* isolate,size_t index){
  auto state=isolate->owner.lock();CHECK(state&&state->cx==js::TlsContext.get());
  state->AssertForeground();CHECK_LT(index,state->eternalRoots.size());
  return Local<Data>(state->eternalRoots[index].get());
}
// Native-only cleanup leaves an existing failure visible and restores exactly
// its status/value/stack, using the engine's existing exception-state API.
struct PreserveNativeFailure {
  JSContext* cx;
  JS::ExceptionStatus status;
  JS::RootedValue value;
  JS::Rooted<js::SavedFrame*> stack;
  explicit PreserveNativeFailure(JSContext* input)
      :cx(input),status(cx->exceptionStatus()),value(cx),stack(cx){
    if(cx->isExceptionPending()){
      value=cx->getPendingExceptionUnwrapped();stack=cx->getPendingExceptionStack();
    }
  }
  ~PreserveNativeFailure(){
    if(status!=JS::ExceptionStatus::None)cx->restorePendingExceptionState(status,value,stack);
  }
};
struct WeakGlobalCallback {
  std::function<void(Isolate*)> callback;
  uv_thread_t foreground=uv_thread_self();
  bool cancelled=false,registered=true;
  explicit WeakGlobalCallback(std::function<void(Isolate*)> input):callback(std::move(input)) {}
};
struct GlobalRoot {
  std::weak_ptr<State> state;
  // The C++ wrapper remains stable across weak/strong transitions. Only its
  // PersistentRootedValue registration changes, so borrowing the native Local
  // never exposes a moving JS pointer or accidentally keeps a weak target alive.
  std::unique_ptr<Data> strong;
  JS::Heap<JSObject*> weak{nullptr};
  bool weakMode=false;
  std::shared_ptr<WeakGlobalCallback> weakCallback;
  GlobalRoot* inventoryPrevious=nullptr;
  GlobalRoot* inventoryNext=nullptr;
  bool inventoried=false;
  ~GlobalRoot(){
    if(!inventoried)return;
    if(auto owner=state.lock()){
      std::lock_guard lock(owner->globalRootsMutex);
      if(inventoryPrevious)inventoryPrevious->inventoryNext=inventoryNext;
      else {CHECK(owner->globalRootsHead==this);owner->globalRootsHead=inventoryNext;}
      if(inventoryNext)inventoryNext->inventoryPrevious=inventoryPrevious;
    }
  }
};
std::pair<size_t,size_t> NativeGlobalHandleBytes(State& state){
  std::lock_guard lock(state.globalRootsMutex);size_t capacity=0,used=0;
  for(auto* root=state.globalRootsHead;root;root=root->inventoryNext){
    CHECK_LE(sizeof(GlobalRoot),SIZE_MAX-capacity);capacity+=sizeof(GlobalRoot);
    const bool occupied=root->weakMode?root->weak.unbarrieredGet()!=nullptr:
        root->strong&&root->strong->cell().value.initialized();
    if(occupied){CHECK_LE(sizeof(GlobalRoot),SIZE_MAX-used);used+=sizeof(GlobalRoot);}
  }
  return {capacity,used};
}
void CancelGlobalCallback(const std::shared_ptr<GlobalRoot>& root) {
  if(root&&root->weakCallback)root->weakCallback->cancelled=true;
}
std::shared_ptr<GlobalRoot> NewGlobalRoot(Isolate* isolate,Local<Data> value) {
  auto& frame=Current(isolate);CHECK(!value.IsEmpty());
  auto root=std::make_shared<GlobalRoot>();root->state=frame.state;root->strong=RetainRoot(isolate,value);
  {
    std::lock_guard lock(frame.state->globalRootsMutex);
    root->inventoryNext=frame.state->globalRootsHead;
    if(root->inventoryNext)root->inventoryNext->inventoryPrevious=root.get();
    frame.state->globalRootsHead=root.get();root->inventoried=true;
  }
  return root;
}
Local<Data> ReadGlobalRoot(Isolate* isolate,const std::shared_ptr<GlobalRoot>& root) {
  auto& frame=Current(isolate);if(!root)return {};
  CHECK(root->state.lock()==frame.state);frame.state->AssertForeground();
  JS::RootedValue value(frame.cx);
  if(root->weakMode){if(!root->weak)return {};value.setObject(*root->weak);}
  else {if(!root->strong||!root->strong->cell().value.initialized())return {};value=root->strong->cell().value;}
  if(root->strong->IsValue()&&!JS_WrapValue(frame.cx,&value))return {};return frame.OwnClone(*root->strong,value);
}
bool GlobalRootIsEmpty(const std::shared_ptr<GlobalRoot>& root) {
  if(!root)return true;
  if(auto state=root->state.lock())state->AssertForeground();
  return root->weakMode?!root->weak:!root->strong||!root->strong->cell().value.initialized();
}
JSObject* BorrowGlobalObject(const std::shared_ptr<GlobalRoot>& root) {
  if(!root)return nullptr;
  if(root->weakMode)return root->weak;
  if(!root->strong||!root->strong->cell().value.initialized())return nullptr;
  const auto value=root->strong->cell().value.get();CHECK(value.isObject());return &value.toObject();
}
void MakeGlobalWeak(Isolate* isolate,const std::shared_ptr<GlobalRoot>& root) {
  auto& frame=Current(isolate);CHECK(root&&root->state.lock()==frame.state&&!root->weakMode&&root->strong);
  frame.state->AssertForeground();
  // Contexts and templates are Data rather than public JavaScript Values,
  // but their actual collector backing is still an object. Preserve the typed
  // native wrapper/factory while weakening that real object edge.
  CHECK(root->strong->cell().value.isObject());JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,root->strong->cell().value));CHECK(object);
  // Weak-zone callbacks update tenured edges. Promote a nursery target while
  // its actual strong root is still installed, before publishing a weak edge.
  // This avoids treating a nursery post-barrier as a strong weak-handle root.
  if(js::gc::IsInsideNursery(object)){
    JS::PrepareForFullGC(frame.cx);JS::NonIncrementalGC(frame.cx,JS::GCOptions::Normal,JS::GCReason::API);
    CHECK(!js::gc::IsInsideNursery(object));
  }
  // The registry retains only native records. These edges are deliberately
  // weak and are updated by the engine's weak-zone callback, never traced.
  frame.state->weakGlobals.push_back(root);root->weak=object;root->weakMode=true;root->strong->cell().value.reset();
}
void UpdateEngineWeakEdges(JSTracer* tracer,void* raw) {
  auto* state=static_cast<State*>(raw);
  if(state->cppHeap)state->cppHeap->UpdateWeakEdges(tracer);
  UpdateNativeHeapWeakEdges(*state,tracer);
  for(auto it=state->weakGlobals.begin();it!=state->weakGlobals.end();){
    auto& root=*it;
    if(root.use_count()==1){root->weak=nullptr;it=state->weakGlobals.erase(it);}
    else {if(root->weak)JS_UpdateWeakPointerAfterGC(tracer,&root->weak);++it;}
  }
}
void FinalizeEngineWeakCallbacks(JS::GCContext*,JSFinalizeStatus status,void* raw) {
  if(status!=JSFINALIZE_GROUP_START)return;
  auto* state=static_cast<State*>(raw);state->AssertForeground();
  // GROUP_START follows weak-edge clearing and precedes a possible mutator
  // yield. Deferring deletion to the loop would let a native weak pointer be
  // upgraded after its JS wrapper died but before its native owner retired.
  // Parameter callbacks may reset handles and retire native resources here;
  // they must not allocate JS values or invoke JavaScript.
  for(size_t index=0;index<state->weakGlobals.size();++index){
    auto root=state->weakGlobals[index];auto callback=root->weakCallback;
    if(!root->weakMode||root->weak||!callback||callback->cancelled)continue;
    callback->cancelled=true;
    CHECK(!state->deliveringWeakCallback);
    state->deliveringWeakCallback=true;
    auto restore=mozilla::MakeScopeExit([&]{state->deliveringWeakCallback=false;});
    callback->callback(&state->isolate);
    CHECK(!callback->registered);
  }
}
}

namespace v8 {
namespace {
std::shared_ptr<State> ScopeOwner(Isolate* isolate){
  CHECK(isolate);auto owner=isolate->owner.lock();CHECK(owner);
  // Node creates main/worker contexts on their own threads. Taking a native
  // lock cannot migrate SpiderMonkey's JSContext or make foreign roots safe.
  owner->AssertForeground();CHECK(owner->cx==js::TlsContext.get());return owner;
}
Isolate* CheckEscapableParent(Isolate* isolate){
  ScopeOwner(isolate)->CheckLocalHandleAllocation();return isolate;
}
}
struct LockerData {
  std::shared_ptr<State> owner;
  std::unique_lock<std::recursive_mutex> lock;
  LockerData* previous;
  inline static thread_local LockerData* current=nullptr;
  explicit LockerData(Isolate* isolate)
      :owner(ScopeOwner(isolate)),lock(owner->engineMutex),previous(current){
    CHECK(owner->lockerDepth<SIZE_MAX);++owner->lockerDepth;current=this;
  }
  ~LockerData(){
    owner->AssertForeground();CHECK(owner->cx==js::TlsContext.get());
    CHECK(current==this&&owner->lockerDepth);current=previous;--owner->lockerDepth;
  }
};
Locker::Locker(Isolate* isolate):data_(std::make_unique<LockerData>(isolate)){}
Locker::~Locker()=default;
bool Locker::IsLocked(Isolate* isolate){
  // Query only this thread's actual lock stack. Do not read a foreign context
  // or race another thread's mutable lock bookkeeping.
  for(auto* lock=LockerData::current;lock;lock=lock->previous)
    if(&lock->owner->isolate==isolate)return true;
  return false;
}
struct SealHandleScopeData {
  std::shared_ptr<State> owner;
  const size_t level;
  const std::optional<size_t> previousLevel;
  SealHandleScopeData* previous;
  explicit SealHandleScopeData(Isolate* isolate):owner(ScopeOwner(isolate)),
      level(owner->handleScopeLevel),previousLevel(owner->sealedHandleLevel),previous(owner->activeHandleSeal){
    owner->sealedHandleLevel=level;owner->activeHandleSeal=this;
  }
  ~SealHandleScopeData(){
    owner->AssertForeground();CHECK(owner->cx==js::TlsContext.get());
    CHECK(owner->activeHandleSeal==this&&owner->handleScopeLevel==level);
    owner->sealedHandleLevel=previousLevel;owner->activeHandleSeal=previous;
  }
};
SealHandleScope::SealHandleScope(Isolate* isolate):data_(std::make_unique<SealHandleScopeData>(isolate)){}
SealHandleScope::~SealHandleScope()=default;
struct IsolateScopeData {
  std::shared_ptr<State> owner;
  IsolateScopeData* previous;
  inline static thread_local IsolateScopeData* current=nullptr;
  explicit IsolateScopeData(Isolate* isolate):owner(isolate->owner.lock()),previous(current){
    CHECK(owner&&owner->cx==js::TlsContext.get());current=this;
  }
  ~IsolateScopeData(){CHECK(current==this);current=previous;}
};
Isolate::Scope::Scope(Isolate* isolate):data_(std::make_unique<IsolateScopeData>(isolate)){}
Isolate::Scope::~Scope()=default;
struct HandleScopeEntry {
  std::shared_ptr<State> state;
  JSContext* cx;
  JS::RootedObject realm;
  Frame frame;
  explicit HandleScopeEntry(std::shared_ptr<State> input)
    :state(std::move(input)),cx(state->cx),realm(cx,JS::CurrentGlobalOrNull(cx)),
     frame(cx,realm,state,nullptr,Domain::Environment){
    CHECK(cx==js::TlsContext.get());
    // A handle scope owns roots, not a principal realm. Context::Scope enters
    // an explicitly supplied live context when the caller actually needs one.
  }
};
HandleScope::HandleScope(Isolate* isolate){
  auto state=isolate->owner.lock();CHECK(state&&state->cx==js::TlsContext.get());
  state->AssertForeground();
  if(!Frame::current||Frame::current->state!=state)entry_=std::make_unique<HandleScopeEntry>(state);
  frame_=&Current(isolate);previous_=frame_->roots.size();previousContexts_=frame_->contexts.size();
  previousLevel_=state->handleScopeLevel;previousScope_=state->activeHandleScope;
  CHECK(previousLevel_<SIZE_MAX);++state->handleScopeLevel;state->activeHandleScope=this;
}
HandleScope::~HandleScope(){
  auto& state=*frame_->state;state.AssertForeground();
  CHECK(state.activeHandleScope==this&&state.handleScopeLevel==previousLevel_+1);
  CHECK(!state.sealedHandleLevel||*state.sealedHandleLevel<state.handleScopeLevel);
  frame_->contexts.resize(previousContexts_);frame_->roots.resize(previous_);
  state.handleScopeLevel=previousLevel_;state.activeHandleScope=previousScope_;
}
void HandleScope::CheckEscape()const{
  CHECK(frame_->state->activeHandleScope==this);
  frame_->state->CheckLocalHandleAllocation(previousLevel_);
}
EscapableHandleScope::EscapableHandleScope(Isolate* isolate):HandleScope(CheckEscapableParent(isolate)){}

// This maintained patch relocates both complete V8 queue methods. The normal
// preparation path verifies and stages their complete source input first.
#include "kandelo-node/native-interrupt-upstream/deps/v8/src/execution/kandelo-native-interrupts.inc"

Isolate::~Isolate(){
  CheckNativeIsolateReleased(this);
  std::lock_guard lock(native_interrupt_mutex_);
  CHECK(api_interrupts_queue_.empty()&&!native_interrupts_accepting_);
}
void Isolate::InitializeNativeInterrupts(JSContext* cx){
  CHECK(cx&&cx==js::TlsContext.get()&&!native_interrupt_context_);
  native_interrupt_context_=cx;native_interrupts_accepting_=true;
}
void Isolate::DrainNativeInterruptsForCleanup(){
  auto state=owner.lock();CHECK(state&&state->cx==js::TlsContext.get());
  JSContext* cx=state->cx;js::AssertHeapIsIdle();CHECK_THREAD(cx);
  // AutoSaveExceptionState clears the pending error while saving it. Native
  // retirement must leave it visible to callbacks and restore its exact status
  // and unwrapped value/stack without allocation or an error interceptor.
  PreserveNativeFailure preserve(cx);
  Isolate::DisallowJavascriptExecutionScope noJavascript(this,
      Isolate::DisallowJavascriptExecutionScope::CRASH_ON_FAILURE);
  ++native_interrupt_delivery_depth_;
  auto leave=mozilla::MakeScopeExit([&]{--native_interrupt_delivery_depth_;});
  InvokeApiInterruptCallbacks();
}
void Isolate::CloseNativeInterrupts(){
  auto state=owner.lock();CHECK(state&&state->cx==js::TlsContext.get());
  CHECK_EQ(native_interrupt_delivery_depth_,size_t(0));
  // Actual producer owners must already be joined. Drain callbacks posted by
  // callbacks before closing admission, rather than dropping their payloads.
  DrainNativeInterruptsForCleanup();
  std::lock_guard lock(native_interrupt_mutex_);
  CHECK(api_interrupts_queue_.empty());native_interrupts_accepting_=false;
}
static bool DispatchNativeEngineInterrupts(JSContext* cx){
  CHECK(cx==js::TlsContext.get());
  auto it=nativeEngineOwners.find(cx);if(it==nativeEngineOwners.end())return true;
  auto state=it->second;state->isolate.DrainNativeInterruptsForCleanup();
  // This native void-callback transport does not request cancellation. Other
  // registered callbacks still run and retain their own false/error result.
  return true;
}
static bool RegisterNativeEngineState(const std::shared_ptr<State>& state){
  JSContext* cx=state->cx;CHECK(cx==js::TlsContext.get());state->AssertForeground();
  CHECK(!nativeEngineOwners.contains(cx));state->isolate.owner=state;
  if(!JS_AddWeakPointerZonesCallback(cx,UpdateEngineWeakEdges,state.get())){
    JS_ReportOutOfMemory(cx);return false;
  }
  if(!JS_AddFinalizeCallback(cx,FinalizeEngineWeakCallbacks,state.get())){
    JS_RemoveWeakPointerZonesCallback(cx,UpdateEngineWeakEdges);
    JS_ReportOutOfMemory(cx);return false;
  }
  if(!JS_AddInterruptCallback(cx,DispatchNativeEngineInterrupts)){
    JS_RemoveFinalizeCallback(cx,FinalizeEngineWeakCallbacks);
    JS_RemoveWeakPointerZonesCallback(cx,UpdateEngineWeakEdges);
    JS_ReportOutOfMemory(cx);return false;
  }
  try {nativeEngineOwners.emplace(cx,state);}
  catch(const std::bad_alloc&){
    JS_RemoveFinalizeCallback(cx,FinalizeEngineWeakCallbacks);
    JS_RemoveWeakPointerZonesCallback(cx,UpdateEngineWeakEdges);
    JS_ReportOutOfMemory(cx);return false;
  }
  state->isolate.InitializeNativeInterrupts(cx);
  bridge::RegisterProcessContext();
  return true;
}
static void RetireNativeEngineState(JSContext* cx){
  CHECK(cx==js::TlsContext.get());
  auto it=nativeEngineOwners.find(cx);if(it==nativeEngineOwners.end())return;
  auto state=it->second;state->isolate.CloseNativeInterrupts();
  CHECK(!state->lockerDepth&&!state->handleScopeLevel&&!state->activeHandleScope);
  CHECK(!state->activeHandleSeal&&!state->sealedHandleLevel);
  // The heap must have completed its actual retirement while this context and
  // its native owner registry still exist.
  CHECK(!state->cppHeap);
  RestoreNativeModuleHooks(*state);
  CHECK(!Frame::current||Frame::current->state!=state);
  for(auto* scope=IsolateScopeData::current;scope;scope=scope->previous)CHECK(scope->owner!=state);
  // Original Node owners must already have released their native weak handles.
  // Retire only orphaned bookkeeping, never live native objects or callbacks.
  for(auto& root:state->weakGlobals){
    CHECK_EQ(root.use_count(),1);CHECK(root->strong&&!root->strong->cell().value.initialized());
    CHECK(!root->weakCallback||!root->weakCallback->registered);root->weak=nullptr;
  }
  state->weakGlobals.clear();
  // Drop every engine-owned strong root while the context and GC callbacks
  // still exist. A copied Eternal contains an index, never an owning JS edge.
  state->eternalRoots.clear();state->apiSymbols.clear();state->apiPrivateNames.clear();
  state->undefinedConstant.reset();state->nullConstant.reset();
  state->trueConstant.reset();state->falseConstant.reset();
  state->emptyStringConstant.reset();
  JS_RemoveFinalizeCallback(cx,FinalizeEngineWeakCallbacks);
  JS_RemoveWeakPointerZonesCallback(cx,UpdateEngineWeakEdges);
  state->continuationData.reset();state->compilationOrigins.reset();
  nativeEngineOwners.erase(it);
  bridge::RetireProcessContext();
}
}
#endif
