// Real STATWATCHER ownership over the pinned native fs-poll algorithm.
#include "kandelo-node-stat-poll.h"
#include <cmath>
#include <new>
#include <utility>
namespace { static bool KandeloELDReadCachedTime(JSContext*, uint64_t*); }
namespace js::shell {
namespace StatPoll = kandelo::fs_poll;
template<class T,class... Args>
static T* KandeloStatWatcherNew(Args&&... args) {
  // js_delete is the queue/class deallocator. A throwing C++ material/claim
  // constructor must also release its original js_malloc body before handoff.
  void* memory=js_malloc(sizeof(T));if(!memory)return nullptr;
  try {return new(memory)T(std::forward<Args>(args)...);}
  catch(...){js_free(memory);throw;}
}
struct KandeloStatWatcherState;
struct KandeloStatWatcherWork;
struct KandeloStatWatcherLoop {
  JSContext* cx;
  KandeloNativeWorkQueue* queue;
  size_t references = 1;
  bool detached = false, ok = true;
  StatPoll::uv_loop_t loop;
  KandeloStatWatcherState* first = nullptr;
  KandeloStatWatcherState* starting = nullptr;
  kandelo::memory::Allocation material{sizeof(KandeloStatWatcherLoop)};
  kandelo::memory::Claim claim;
  KandeloStatWatcherLoop(JSContext* context,KandeloNativeWorkQueue* workQueue)
      : cx(context),queue(workQueue), claim(material.Handle(), KandeloNativeMemoryOwner(context)) { loop.data=this; }
  void Retain() { ++references; }
  void Release() { MOZ_RELEASE_ASSERT(references);if(!--references)js_delete(this); }
};
enum StatWatcherSlot { StatWatcherState, StatWatcherFrame, StatWatcherCloseCallback, StatWatcherSlotCount };
struct KandeloStatWatcherState {
  KandeloStatWatcherLoop* loop;
  KandeloStatWatcherState* previous = nullptr;
  KandeloStatWatcherState* next = nullptr;
  KandeloStatWatcherWork* work = nullptr;
  StatPoll::uv_fs_poll_t handle;
  JS::PersistentRootedObject root;
  KandeloNativeAsyncState* lifetime = nullptr;
  double id=-1, trigger=0;
  bool bigint=false, retired=false, gcClosing=false;
  kandelo::memory::Allocation material{sizeof(KandeloStatWatcherState)};
  kandelo::memory::Claim claim;
  KandeloStatWatcherState(JSContext* cx,KandeloStatWatcherLoop* owner,bool bigint)
      : loop(owner),root(cx),bigint(bigint),claim(material.Handle(),KandeloNativeMemoryOwner(cx)) {
    loop->Retain();StatPoll::uv_fs_poll_init(&loop->loop,&handle);handle.data=this;
    next=loop->first;if(next)next->previous=this;loop->first=this;
  }
  void Retire() { if(!retired){retired=true;if(lifetime)lifetime->Finalized(id);} }
  ~KandeloStatWatcherState() {
    MOZ_RELEASE_ASSERT(!work && !root && !handle.poll_ctx);
    Retire();if(lifetime)lifetime->Release();
    if(previous)previous->next=next;else loop->first=next;
    if(next)next->previous=previous;loop->Release();
  }
};
static void KandeloStatWatcherFinalize(JS::GCContext*,JSObject* object) {
  auto value=JS::GetReservedSlot(object,StatWatcherState);
  if(value.isUndefined())return;
  auto* state=static_cast<KandeloStatWatcherState*>(value.toPrivate());
  MOZ_RELEASE_ASSERT(!state->work && !state->root && !state->handle.poll_ctx);
  if(!state->retired && !state->loop->detached){
    // An inactive weak JS wrapper still has a real asynchronous handle close.
    // Transfer only native state to the close queue; never resurrect a GC'd
    // JS object/frame or run a user callback from its finalizer.
    state->gcClosing=true;StatPoll::ClosePoll(&state->handle);return;
  }
  js_delete(state);
}
static const JSClassOps KandeloStatWatcherClassOps = {
  nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,KandeloStatWatcherFinalize,nullptr,nullptr,nullptr
};
static const JSClass KandeloStatWatcherClass = {
  "StatWatcher",JSCLASS_HAS_RESERVED_SLOTS(StatWatcherSlotCount)|JSCLASS_FOREGROUND_FINALIZE,
  &KandeloStatWatcherClassOps
};
static KandeloStatWatcherState* KandeloStatWatcherStateOf(JSContext* cx,HandleObject object) {
  if(JS::GetClass(object)!=&KandeloStatWatcherClass){JS_ReportErrorASCII(cx,"Invalid native StatWatcher receiver");return nullptr;}
  auto value=JS::GetReservedSlot(object,StatWatcherState);
  if(value.isUndefined()){JS_ReportErrorASCII(cx,"Uninitialized native StatWatcher receiver");return nullptr;}
  return static_cast<KandeloStatWatcherState*>(value.toPrivate());
}
static bool KandeloStatWatcherResourceInfo(JSContext* cx,HandleObject object,MutableHandleValue result) {
  auto* state=KandeloStatWatcherStateOf(cx,object);if(!state)return false;
  JS::RootedValueArray<4> entries(cx);entries[0].setNumber(state->id);entries[1].setNumber(state->trigger);
  entries[2].set(JS::GetReservedSlot(object,StatWatcherFrame));
  RootedString name(cx,JS_NewStringCopyZ(cx,"STATWATCHER"));if(!name)return false;entries[3].setString(name);
  RootedObject array(cx,JS::NewArrayObject(cx,entries));if(!array)return false;result.setObject(*array);return true;
}
template<typename T> static void KandeloStatWatcherFields(const StatPoll::uv_stat_t& s,T* values) {
  values[0]=T(s.st_dev);values[1]=T(s.st_mode);values[2]=T(s.st_nlink);values[3]=T(s.st_uid);
  values[4]=T(s.st_gid);values[5]=T(s.st_rdev);values[6]=T(s.st_blksize);values[7]=T(s.st_ino);
  values[8]=T(s.st_size);values[9]=T(s.st_blocks);values[10]=T(s.st_atim.tv_sec);values[11]=T(s.st_atim.tv_nsec);
  values[12]=T(s.st_mtim.tv_sec);values[13]=T(s.st_mtim.tv_nsec);values[14]=T(s.st_ctim.tv_sec);values[15]=T(s.st_ctim.tv_nsec);
  values[16]=T(s.st_birthtim.tv_sec);values[17]=T(s.st_birthtim.tv_nsec);
}
static void KandeloStatWatcherChanged(StatPoll::uv_fs_poll_t* handle,int status,
    const StatPoll::uv_stat_t* previous,const StatPoll::uv_stat_t* current) {
  auto* state=static_cast<KandeloStatWatcherState*>(handle->data);auto* loop=state->loop;
  if(loop->detached || !loop->ok)return;
  JSContext* cx=loop->cx;RootedObject owner(cx,state->root);
  JSAutoRealm realm(cx,owner);
  RootedObject stats(cx,state->bigint?JS_NewBigInt64Array(cx,36):JS_NewFloat64Array(cx,36));
  if(!stats){loop->ok=false;return;}
  {JS::AutoCheckCannotGC nogc;bool shared;
   if(state->bigint){auto* values=JS_GetBigInt64ArrayData(stats,&shared,nogc);KandeloStatWatcherFields(*current,values);KandeloStatWatcherFields(*previous,values+18);}
   else{auto* values=JS_GetFloat64ArrayData(stats,&shared,nogc);KandeloStatWatcherFields(*current,values);KandeloStatWatcherFields(*previous,values+18);}}
  // MakeCallback resolves the property before entering the callback scope.
  RootedValue callback(cx);if(!JS_GetProperty(cx,owner,"onchange",&callback)){loop->ok=false;return;}
  if(!callback.isObject() || !JS::IsCallable(&callback.toObject()))return;
  RootedValue frame(cx,JS::GetReservedSlot(owner,StatWatcherFrame));
  KandeloNativeCallbackScope scope(cx,owner,frame);
  if(!scope.Enter()){loop->ok=false;return;}
  bool ok=true;
  if(!scope.Stopped()){
    JS::RootedValueArray<2> argv(cx);argv[0].setInt32(status);argv[1].setObject(*stats);RootedValue result(cx);
    ok=JS::Call(cx,owner,callback,argv,&result);
  }
  loop->ok=scope.Close()&&ok;
}
struct KandeloStatWatcherWork final : KandeloNativeWork {
  KandeloStatWatcherState* state;
  StatPoll::uv_fs_t* request;
  JS::PersistentRootedObject owner;
  struct stat metadata{};
  int error=0;
  kandelo::memory::Allocation material{sizeof(KandeloStatWatcherWork)};
  kandelo::memory::Claim claim;
  KandeloStatWatcherWork(JSContext* cx,KandeloStatWatcherState* state,StatPoll::uv_fs_t* request)
      : state(state),request(request),owner(cx,state->root),claim(material.Handle(),KandeloNativeMemoryOwner(cx)) {workClass=WorkClass::FastIo;}
  void Run() override {error=StatPoll::StatPath(request->path,&metadata);}
  bool Finish(JSContext* cx,bool silent) {
    auto* loop=state->loop;state->work=nullptr;
    if(!silent)loop->ok=true;
    if(silent || failure!=Failure::None){
      // Teardown first stops the parent. The unchanged algorithm then owns
      // request/timer context cleanup without entering a detached JS realm.
      StatPoll::ClosePoll(&state->handle);error=-ECANCELED;
    }
    StatPoll::CompleteStat(request,error,error?nullptr:&metadata);
    if(silent)return true;
    if(failure==Failure::OutOfMemory){JS_ReportOutOfMemory(cx);return false;}
    if(failure==Failure::NativeException){JS_ReportErrorASCII(cx,"Native StatWatcher work failed");return false;}
    return loop->ok;
  }
  bool Complete(JSContext* cx) override {return Finish(cx,false);}
  void Cancel(JSContext* cx) override {(void)Finish(cx,true);}
};
static int KandeloStatWatcherSubmit(StatPoll::uv_loop_t* loop,StatPoll::uv_fs_t* request) {
  auto* owner=static_cast<KandeloStatWatcherLoop*>(loop->data);
  // fs-poll.c embeds each request in its context; its parent handle's data is
  // reached through the unchanged algorithm's timer/parent lifecycle. The
  // owning state being started/dispatched is explicit, not guessed from JS.
  KandeloStatWatcherState* state=nullptr;
  for(auto* candidate=owner->first;candidate;candidate=candidate->next)
    if(candidate->handle.poll_ctx && !candidate->work && StatPoll::Active(&candidate->handle)) {
      // Request identity is resolved by the native port, not path equality.
      if(StatPoll::OwnsRequest(&candidate->handle,request)){state=candidate;break;}
    }
  if(!state)state=owner->starting;
  if(!state || owner->detached)return -ECANCELED;
  try {
    auto* work=KandeloStatWatcherNew<KandeloStatWatcherWork>(owner->cx,state,request);if(!work)return -ENOMEM;
    if(!owner->queue->Submit(work)){js_delete(work);return -EAGAIN;}
    state->work=work;return 0;
  } catch(const std::bad_alloc&) { return -ENOMEM; }

}
static void KandeloStatWatcherClosed(StatPoll::uv_fs_poll_t* handle) {
  auto* state=static_cast<KandeloStatWatcherState*>(handle->data);auto* loop=state->loop;
  if(state->gcClosing){state->Retire();js_delete(state);return;}
  if(loop->detached){state->Retire();state->root.reset();return;}
  JSContext* cx=loop->cx;RootedObject owner(cx,state->root);JSAutoRealm realm(cx,owner);
  RootedValue callback(cx,JS::GetReservedSlot(owner,StatWatcherCloseCallback));
  JS::SetReservedSlot(owner,StatWatcherCloseCallback,UndefinedValue());
  if(callback.isObject() && JS::IsCallable(&callback.toObject()) && loop->ok){
    RootedValue frame(cx,JS::GetReservedSlot(owner,StatWatcherFrame));KandeloNativeCallbackScope scope(cx,owner,frame);
    if(!scope.Enter())loop->ok=false;
    else{bool ok=true;if(!scope.Stopped()){RootedValue result(cx);ok=JS::Call(cx,owner,callback,JS::HandleValueArray::empty(),&result);}loop->ok=scope.Close()&&ok;}
  }
  state->Retire();state->root.reset();
}
static KandeloStatWatcherLoop* KandeloGetStatWatcherLoop(JSContext* cx) {
  auto* sc=GetShellContext(cx);
  if(!sc->kandeloStatWatchers){
    uint64_t cachedTime;
    if(!KandeloELDReadCachedTime(cx,&cachedTime))return nullptr;
    auto* queue=KandeloGetNativeWorkQueue(cx);if(!queue)return nullptr;
    auto* loop=KandeloStatWatcherNew<KandeloStatWatcherLoop>(cx,queue);if(!loop){JS_ReportOutOfMemory(cx);return nullptr;}
    // uv_fs_poll_start consumes uv_now's existing cache. A newly allocated
    // watcher context joins that clock without advancing other timer owners.
    StatPoll::UpdateTime(&loop->loop,cachedTime);
    loop->loop.submit=KandeloStatWatcherSubmit;loop->loop.closed=KandeloStatWatcherClosed;
    sc->kandeloStatWatchers=loop;
  }
  return sc->kandeloStatWatchers;
}
static bool KandeloNativeStatWatcher(JSContext* cx,unsigned argc,Value* vp) {
  try {
  CallArgs args=CallArgsFromVp(argc,vp);JS::UniqueChars operation;
  if(!KandeloGetString(cx,args.get(0),&operation))return false;
  if(strcmp(operation.get(),"create")==0){
    if(!args.get(1).isObject()){JS_ReportErrorASCII(cx,"StatWatcher prototype is required");return false;}
    RootedObject prototype(cx,&args[1].toObject());RootedObject owner(cx,JS_NewObjectWithGivenProto(cx,&KandeloStatWatcherClass,prototype));if(!owner)return false;
    auto* loop=KandeloGetStatWatcherLoop(cx);if(!loop)return false;
    auto* state=KandeloStatWatcherNew<KandeloStatWatcherState>(cx,loop,args.get(2).isTrue());if(!state){JS_ReportOutOfMemory(cx);return false;}
    JS::SetReservedSlot(owner,StatWatcherState,PrivateValue(state));
    RootedValue frame(cx);if(!cx->kandeloAsyncProperty("frame",&frame)||!cx->getKandeloDefaultTriggerAsyncId(&state->trigger))return false;
    state->lifetime=KandeloGetNativeAsyncState(cx);if(!state->lifetime)return false;state->lifetime->Retain();
    state->id=cx->allocateKandeloAsyncId();JS::SetReservedSlot(owner,StatWatcherFrame,frame);
    if(!cx->notifyKandeloAsyncLifecycle("native:init",owner,frame)){
      // A reentrant init hook may already have started/closed this real
      // handle. Preserve the original exception and retire any published work.
      if(state->work || StatPoll::Active(&state->handle) || StatPoll::Closing(&state->handle)){
        state->root=owner;StatPoll::ClosePoll(&state->handle);
      }
      return false;
    }
    args.rval().setObject(*owner);return true;
  }
  if(!args.get(1).isObject()){JS_ReportErrorASCII(cx,"StatWatcher receiver is required");return false;}
  RootedObject supplied(cx,&args[1].toObject());
  RootedObject owner(cx,js::CheckedUnwrapStatic(supplied));
  if(!owner){JS_ReportErrorASCII(cx,"Cannot access native StatWatcher receiver");return false;}
  JSAutoRealm realm(cx,owner);
  auto* state=KandeloStatWatcherStateOf(cx,owner);if(!state)return false;
  const char* op=operation.get();
  if(!strcmp(op,"getAsyncId")){args.rval().setNumber(state->id);return true;}
  if(!strcmp(op,"hasRef")){args.rval().setBoolean(!StatPoll::Closing(&state->handle)&&StatPoll::HasRef(&state->handle));return true;}
  if(!strcmp(op,"ref")||!strcmp(op,"unref")){if(!StatPoll::Closing(&state->handle))StatPoll::Ref(&state->handle,!strcmp(op,"ref"));args.rval().setUndefined();return true;}
  if(!strcmp(op,"close")){
    if(!StatPoll::Closing(&state->handle)){
      RootedValue callback(cx,args.get(2));
      const bool callable=callback.isObject()&&JS::IsCallable(&callback.toObject());
      if(callable && !JS_WrapValue(cx,&callback))return false;
      // Prepare the recipient-realm callback before publishing a closing root.
      // A failed wrap must not strand an inactive handle behind its own root.
      state->root=owner;
      if(callable)JS::SetReservedSlot(owner,StatWatcherCloseCallback,callback);
      StatPoll::ClosePoll(&state->handle);
    }
    args.rval().setUndefined();return true;
  }
  if(strcmp(op,"start")){JS_ReportErrorASCII(cx,"Unknown native StatWatcher operation");return false;}
  if(StatPoll::Closing(&state->handle)){args.rval().setUndefined();return true;}
  JS::UniqueChars path;size_t length;
  if(!KandeloFsPath(cx,args.get(2),&path,&length))return false;
  if(!args.get(3).isNumber() || args[3].toNumber()<0 || args[3].toNumber()>UINT32_MAX || std::trunc(args[3].toNumber())!=args[3].toNumber()) {JS_ReportErrorASCII(cx,"StatWatcher interval must be uint32");return false;}
  state->root=owner;auto* loop=state->loop;loop->starting=state;
  const int status=StatPoll::StartPoll(&state->handle,KandeloStatWatcherChanged,path.get(),uint32_t(args[3].toNumber()),KandeloNativeMemoryOwner(cx));
  loop->starting=nullptr;if(status && !state->work)state->root.reset();
  if(status)args.rval().setInt32(status);else args.rval().setUndefined();return true;
  } catch(const std::bad_alloc&) { JS_ReportOutOfMemory(cx);return false; }
}
static bool KandeloStatWatcherReferences(JSContext* cx) {
  auto* loop=GetShellContext(cx)->kandeloStatWatchers;if(!loop)return false;
  if(loop->loop.closing)return true;
  for(auto* state=loop->first;state;state=state->next)
    if(StatPoll::Active(&state->handle)&&StatPoll::HasRef(&state->handle))return true;
  return false;
}
static void KandeloStatWatcherUpdateCachedTime(JSContext* cx,uint64_t cachedMonotonicMilliseconds) {
  auto* loop=GetShellContext(cx)->kandeloStatWatchers;
  if(loop)StatPoll::UpdateTime(&loop->loop,cachedMonotonicMilliseconds);
}
static int64_t KandeloStatWatcherDelay(JSContext* cx) {
  auto* loop=GetShellContext(cx)->kandeloStatWatchers;
  return loop?StatPoll::NextDelay(&loop->loop):-1;
}
static int KandeloDispatchStatWatchers(JSContext* cx,bool closePhase) {
  auto* loop=GetShellContext(cx)->kandeloStatWatchers;if(!loop)return 0;
  loop->ok=true;
  const bool ran=closePhase?StatPoll::RunOneClose(&loop->loop):StatPoll::RunOneTimer(&loop->loop);
  return loop->ok?int(ran):-1;
}
static void KandeloStopStatWatchers(ShellContext* sc) {
  auto* loop=sc->kandeloStatWatchers;if(!loop)return;
  loop->detached=true;
  for(auto* state=loop->first;state;state=state->next)
    if(state->root)StatPoll::ClosePoll(&state->handle);
}
static void KandeloShutdownStatWatchers(ShellContext* sc) {
  auto* loop=sc->kandeloStatWatchers;if(!loop)return;
  // Call only after native-work shutdown has joined/drained every stat job.
  while(StatPoll::RunOneClose(&loop->loop)){}
  MOZ_RELEASE_ASSERT(!loop->loop.timers && !loop->loop.closing);
  loop->cx=nullptr;sc->kandeloStatWatchers=nullptr;loop->Release();
}
}  // namespace js::shell
