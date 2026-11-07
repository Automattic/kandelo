// Actual main-environment signal owners. C handlers only write pipe records;
// the owning loop alone enters JS and owns callback/async/close retirement.
#include "kandelo-node-signal-owner.h"
#include "kandelo-node-signal-constants.h"
#include <new>
#include <utility>
namespace js::shell {
namespace NativeSignal = kandelo::signals;
template<class T,class... Args> static T* KandeloSignalNew(Args&&... args){
  void* body=js_malloc(sizeof(T));if(!body)return nullptr;
  try{return new(body)T(std::forward<Args>(args)...);}
  catch(...){js_free(body);throw;}
}
struct KandeloSignalState;
struct KandeloSignalLoop {
  JSContext* cx;
  size_t references=1;
  bool detached=false;
  NativeSignal::Loop transport;
  KandeloSignalState* first=nullptr;
  kandelo::memory::Allocation material{sizeof(KandeloSignalLoop)};
  kandelo::memory::Claim claim;
  explicit KandeloSignalLoop(JSContext* context)
      :cx(context),claim(material.Handle(),KandeloNativeMemoryOwner(context)) {}
  void Retain(){++references;}
  void Release(){MOZ_RELEASE_ASSERT(references);if(!--references)js_delete(this);}
};
// Only the real main entry installs this pointer. Worker entry points never
// construct the environment scope and cannot acquire process dispositions.
static thread_local KandeloSignalLoop* kandeloSignalLoop=nullptr;
enum SignalSlot { SignalStateSlot, SignalFrame, SignalCloseCallback, SignalSlotCount };
struct KandeloSignalState {
  KandeloSignalLoop* loop;
  KandeloSignalState* previous=nullptr;
  KandeloSignalState* next=nullptr;
  NativeSignal::Watch watch;
  JS::PersistentRootedObject root;
  KandeloNativeAsyncState* lifetime=nullptr;
  double id=-1,trigger=0;
  bool retired=false,gcClosing=false;
  kandelo::memory::Allocation material{sizeof(KandeloSignalState)};
  kandelo::memory::Claim claim;
  KandeloSignalState(JSContext* cx,KandeloSignalLoop* owner)
      :loop(owner),watch(owner->transport),root(cx),claim(material.Handle(),KandeloNativeMemoryOwner(cx)) {
    loop->Retain();next=loop->first;if(next)next->previous=this;loop->first=this;
  }
  void Retire(){if(!retired){retired=true;if(lifetime)lifetime->Finalized(id);}}
  ~KandeloSignalState(){
    MOZ_RELEASE_ASSERT(!root);Retire();if(lifetime)lifetime->Release();
    if(previous)previous->next=next;else loop->first=next;if(next)next->previous=previous;
  }
};
static void KandeloDeleteSignalState(KandeloSignalState* state){
  auto* loop=state->loop;js_delete(state);loop->Release();
}
static void KandeloSignalFinalize(JS::GCContext*,JSObject* object){
  auto value=JS::GetReservedSlot(object,SignalStateSlot);if(value.isUndefined())return;
  auto* state=static_cast<KandeloSignalState*>(value.toPrivate());
  MOZ_RELEASE_ASSERT(!state->root);
  if(!state->loop->detached && !state->watch.closed){
    state->gcClosing=true;MOZ_RELEASE_ASSERT(!state->watch.Close());return;
  }
  KandeloDeleteSignalState(state);
}
static const JSClassOps KandeloSignalClassOps={
  nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,KandeloSignalFinalize,nullptr,nullptr,nullptr
};
static const JSClass KandeloSignalClass={
  "Signal",JSCLASS_HAS_RESERVED_SLOTS(SignalSlotCount)|JSCLASS_FOREGROUND_FINALIZE,&KandeloSignalClassOps
};
static KandeloSignalState* KandeloSignalStateOf(JSContext* cx,HandleObject owner){
  if(JS::GetClass(owner)!=&KandeloSignalClass){JS_ReportErrorASCII(cx,"Invalid native Signal receiver");return nullptr;}
  auto value=JS::GetReservedSlot(owner,SignalStateSlot);
  if(value.isUndefined()){JS_ReportErrorASCII(cx,"Uninitialized native Signal receiver");return nullptr;}
  return static_cast<KandeloSignalState*>(value.toPrivate());
}
static bool KandeloSignalResourceInfo(JSContext* cx,HandleObject owner,MutableHandleValue result){
  auto* state=KandeloSignalStateOf(cx,owner);if(!state)return false;
  JS::RootedValueArray<4> entries(cx);entries[0].setNumber(state->id);entries[1].setNumber(state->trigger);
  entries[2].set(JS::GetReservedSlot(owner,SignalFrame));RootedString name(cx,JS_NewStringCopyZ(cx,"SIGNALWRAP"));if(!name)return false;
  entries[3].setString(name);RootedObject array(cx,JS::NewArrayObject(cx,entries));if(!array)return false;result.setObject(*array);return true;
}
static bool KandeloSignalError(JSContext* cx,int error){
  JS_ReportErrorASCII(cx,"Native process signal operation failed: errno %d",error);return false;
}
static bool KandeloNativeSignals(JSContext* cx,unsigned argc,Value* vp){
  try {
    CallArgs args=CallArgsFromVp(argc,vp);UniqueChars operation;
    if(!KandeloGetString(cx,args.get(0),&operation))return false;
    const char* op=operation.get();
    if(!strcmp(op,"constants")){
      RootedObject constants(cx,JS_NewObjectWithGivenProto(cx,nullptr,nullptr));if(!constants)return false;
      if(!NativeSignal::DefineConstants([&](const char* name,int value){
        return JS_DefineProperty(cx,constants,name,value,JSPROP_ENUMERATE|JSPROP_READONLY|JSPROP_PERMANENT);
      }))return false;
      args.rval().setObject(*constants);return true;
    }
    if(!strcmp(op,"create")){
      auto* loop=kandeloSignalLoop;
      if(!loop || loop->cx!=cx || loop->detached){JS_ReportErrorASCII(cx,"Signals require the actual main process environment");return false;}
      if(!args.get(1).isObject()){JS_ReportErrorASCII(cx,"Signal prototype is required");return false;}
      RootedObject prototype(cx,&args[1].toObject());RootedObject owner(cx,JS_NewObjectWithGivenProto(cx,&KandeloSignalClass,prototype));if(!owner)return false;
      auto* state=KandeloSignalNew<KandeloSignalState>(cx,loop);if(!state){JS_ReportOutOfMemory(cx);return false;}
      JS::SetReservedSlot(owner,SignalStateSlot,PrivateValue(state));
      RootedValue frame(cx);if(!cx->kandeloAsyncProperty("frame",&frame)||!cx->getKandeloDefaultTriggerAsyncId(&state->trigger))return false;
      state->lifetime=KandeloGetNativeAsyncState(cx);if(!state->lifetime)return false;state->lifetime->Retain();
      state->id=cx->allocateKandeloAsyncId();JS::SetReservedSlot(owner,SignalFrame,frame);
      if(!cx->notifyKandeloAsyncLifecycle("native:init",owner,frame))return false;
      args.rval().setObject(*owner);return true;
    }
    if(!args.get(1).isObject()){JS_ReportErrorASCII(cx,"Signal receiver is required");return false;}
    RootedObject supplied(cx,&args[1].toObject());RootedObject owner(cx,js::CheckedUnwrapStatic(supplied));
    if(!owner){JS_ReportErrorASCII(cx,"Cannot access native Signal receiver");return false;}
    JSAutoRealm realm(cx,owner);auto* state=KandeloSignalStateOf(cx,owner);if(!state)return false;
    auto& watch=state->watch;
    if(!strcmp(op,"getAsyncId")){args.rval().setNumber(state->id);return true;}
    if(!strcmp(op,"hasRef")){args.rval().setBoolean(!watch.closing&&!watch.closed&&watch.referenced);return true;}
    if(!strcmp(op,"ref")||!strcmp(op,"unref")){
      if(!watch.closing&&!watch.closed)watch.referenced=!strcmp(op,"ref");args.rval().setUndefined();return true;
    }
    if(!strcmp(op,"close")){
      if(!watch.closing&&!watch.closed){
        RootedValue callback(cx,args.get(2));const bool callable=callback.isObject()&&JS::IsCallable(&callback.toObject());
        if(callable&&!JS_WrapValue(cx,&callback))return false;
        const int error=watch.Close();if(error)return KandeloSignalError(cx,error);
        state->root=owner;if(callable)JS::SetReservedSlot(owner,SignalCloseCallback,callback);
      }
      args.rval().setUndefined();return true;
    }
    if(watch.closing||watch.closed){args.rval().setUndefined();return true;}
    if(!strcmp(op,"start")){
      int32_t signum;if(!JS::ToInt32(cx,args.get(2),&signum))return false;
      const int error=watch.Start(signum);
      // Failed replacement can leave real pending records from the old
      // subscription; retain its original owner until those records retire.
      if(!error || watch.HasPending())state->root=owner;
      else if(!watch.signum)state->root.reset();
      args.rval().setInt32(-error);return true;
    }
    if(!strcmp(op,"stop")){
      const int error=watch.Stop();if(!error&&!watch.HasPending())state->root.reset();args.rval().setInt32(-error);return true;
    }
    JS_ReportErrorASCII(cx,"Unknown native Signal operation");return false;
  }catch(const std::bad_alloc&){JS_ReportOutOfMemory(cx);return false;}
}
static bool KandeloSignalsHaveReferences(JSContext* cx){
  auto* loop=kandeloSignalLoop;return loop&&loop->cx==cx&&loop->transport.HasReferences();
}
static int KandeloDispatchSignals(JSContext* cx,bool closePhase){
  auto* loop=kandeloSignalLoop;if(!loop||loop->cx!=cx||loop->detached)return 0;
  if(closePhase){
    auto* ready=loop->transport.ReadyClose();if(!ready)return 0;
    KandeloSignalState* state=loop->first;while(state && &state->watch!=ready)state=state->next;MOZ_RELEASE_ASSERT(state);
    ready->closing=false;ready->closed=true;
    if(state->gcClosing){state->Retire();KandeloDeleteSignalState(state);return 1;}
    RootedObject owner(cx,state->root);JSAutoRealm realm(cx,owner);
    RootedValue callback(cx,JS::GetReservedSlot(owner,SignalCloseCallback));JS::SetReservedSlot(owner,SignalCloseCallback,UndefinedValue());
    bool ok=true;
    if(callback.isObject()&&JS::IsCallable(&callback.toObject())){
      RootedValue frame(cx,JS::GetReservedSlot(owner,SignalFrame));KandeloNativeCallbackScope scope(cx,owner,frame);
      if(!scope.Enter())ok=false;
      else if(scope.Stopped())ok=scope.Close();
      else{RootedValue result(cx);ok=JS::Call(cx,owner,callback,JS::HandleValueArray::empty(),&result)?scope.Close():scope.Fail();}
    }
    state->Retire();state->root.reset();return ok?1:-1;
  }
  NativeSignal::Message message{};const int read=loop->transport.Read(&message);
  if(read<0){KandeloSignalError(cx,-read);return -1;}if(!read)return 0;
  auto* watch=loop->transport.Find(message.cookie);MOZ_RELEASE_ASSERT(watch);
  KandeloSignalState* state=loop->first;while(state && &state->watch!=watch)state=state->next;MOZ_RELEASE_ASSERT(state);
  // Retire the actual pipe record even when stop/replacement/close suppresses
  // its callback. Native state remains rooted until the last such record.
  watch->RetireMessage();
  if(watch->closing||watch->closed||watch->signum!=message.signum){
    if(!watch->signum&&!watch->closing&&!watch->HasPending())state->root.reset();return 1;
  }
  RootedObject owner(cx,state->root);JSAutoRealm realm(cx,owner);
  RootedValue callback(cx);if(!JS_GetProperty(cx,owner,"onsignal",&callback))return -1;
  if(!callback.isObject()||!JS::IsCallable(&callback.toObject()))return 1;
  RootedValue frame(cx,JS::GetReservedSlot(owner,SignalFrame));KandeloNativeCallbackScope scope(cx,owner,frame);
  if(!scope.Enter())return -1;if(scope.Stopped())return scope.Close()?1:-1;
  JS::RootedValueArray<1> argv(cx);argv[0].setInt32(message.signum);RootedValue result(cx);
  const bool ok=JS::Call(cx,owner,callback,argv,&result);return (ok?scope.Close():scope.Fail())?1:-1;
}
class KandeloSignalEnvironmentScope {
  KandeloSignalLoop* loop_=nullptr;
 public:
  KandeloSignalEnvironmentScope(JSContext* cx,HandleObject){
    if(!IsKandeloNodeMode())return;MOZ_RELEASE_ASSERT(!kandeloSignalLoop);
    try { loop_=KandeloSignalNew<KandeloSignalLoop>(cx); }
    catch(const std::bad_alloc&){JS_ReportOutOfMemory(cx);return;}
    if(!loop_){JS_ReportOutOfMemory(cx);return;}
    const int error=loop_->transport.Initialize();
    if(error){js_delete(loop_);loop_=nullptr;KandeloSignalError(cx,error);return;}kandeloSignalLoop=loop_;
  }
  bool Ready()const{return !IsKandeloNodeMode()||loop_;}
  ~KandeloSignalEnvironmentScope(){
    if(!loop_)return;auto* loop=loop_;loop->detached=true;kandeloSignalLoop=nullptr;
    for(auto* state=loop->first;state;state=state->next)MOZ_RELEASE_ASSERT(!state->watch.Stop());
    NativeSignal::Message message{};int read;
    while((read=loop->transport.Read(&message))>0){auto* watch=loop->transport.Find(message.cookie);MOZ_RELEASE_ASSERT(watch);watch->RetireMessage();}
    MOZ_RELEASE_ASSERT(read==0);
    for(auto* state=loop->first;state;){auto* next=state->next;
      MOZ_RELEASE_ASSERT(!state->watch.HasPending());state->watch.closing=false;state->watch.closed=true;state->Retire();state->root.reset();
      if(state->gcClosing)KandeloDeleteSignalState(state);state=next;
    }
    loop->cx=nullptr;loop->Release();
  }
};
} // namespace js::shell
