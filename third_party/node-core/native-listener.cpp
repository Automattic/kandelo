// Real TCP server descriptor and per-environment native async-resource owner.
#include "kandelo-node-listener-owner.h"
#include "js/Wrapper.h"
namespace {
enum KandeloListenerSlot { ListenerState, ListenerFrame, ListenerCloseCallback, ListenerSlots };
struct KandeloListenerState;
static thread_local KandeloListenerState* gKandeloListeners = nullptr;
static thread_local uint64_t gKandeloListenerGeneration = 0;
struct KandeloListenerState {
  JSContext* const cx;
  KandeloListenerState* next = nullptr;
  kandelo::listener::Owner listener;
  js::shell::KandeloNativeAsyncState* lifetime = nullptr;
  std::unique_ptr<PersistentRootedObject> liveRoot;
  double id = -1, trigger = -1;
  size_t accepts = 0;
  bool detached = false, retired = false, closing = false, closeCompleted = false;
  bool callbackActive = false, initializing = true, accepting = false;
  kandelo::memory::Allocation allocation{sizeof(KandeloListenerState)};
  kandelo::memory::Claims claims;
  KandeloListenerState(JSContext* cx, uint64_t generation)
      : cx(cx), listener(generation) {}
  void RefreshMemory() noexcept {
    allocation.Resize(sizeof(KandeloListenerState)+(liveRoot?sizeof(PersistentRootedObject):0));
  }
  void BeginClose() noexcept {
    if (closing || closeCompleted) return;
    accepting = false;listener.Close();closing = true;
  }
  void Retire() noexcept {
    if (!retired && lifetime && id >= 0) { retired = true;lifetime->Finalized(id); }
  }
  ~KandeloListenerState() {
    listener.Close();Retire();if (lifetime) lifetime->Release();
  }
};
static void KandeloListenerFinalize(JS::GCContext*, JSObject* object) {
  const Value slot = JS::GetReservedSlot(object, 0);if (slot.isUndefined()) return;
  auto* state = static_cast<KandeloListenerState*>(slot.toPrivate());
  auto** link = &gKandeloListeners;
  while (*link) {
    if (*link == state) { *link = state->next;break; }
    link = &(*link)->next;
  }
  delete state;
}
static const JSClassOps KandeloListenerOps = {
  nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,KandeloListenerFinalize,
  nullptr,nullptr,nullptr};
static const JSClass KandeloListenerClass = {"TCP",
  JSCLASS_HAS_RESERVED_SLOTS(ListenerSlots) | JSCLASS_FOREGROUND_FINALIZE,&KandeloListenerOps};
static bool KandeloListenerFromValue(JSContext* cx, HandleValue value,
    MutableHandleObject object, KandeloListenerState** state) {
  object.set(nullptr);*state = nullptr;
  if (!value.isObject()) return true;
  object.set(js::CheckedUnwrapDynamic(&value.toObject(),cx));
  if (!object) {
    if (!JS_IsExceptionPending(cx)) js::ReportAccessDenied(cx);
    return false;
  }
  if (JS::GetClass(object) != &KandeloListenerClass) { object.set(nullptr);return true; }
  const auto slot = JS::GetReservedSlot(object,0);
  if (slot.isUndefined()) { JS_ReportErrorASCII(cx,"Uninitialized listener owner");return false; }
  auto* actual = static_cast<KandeloListenerState*>(slot.toPrivate());
  if (actual->cx != cx || actual->detached) {
    JS_ReportErrorASCII(cx,"Listener belongs to a retired or different context");return false;
  }
  *state = actual;return true;
}
// These controls act on the same class that owns bind/listen/accept. The
// public JS Server is not an AsyncWrap resource and receives no invented ID.
static bool KandeloListenerClose(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc,vp);RootedObject owner(cx);KandeloListenerState* state;
  if (!KandeloListenerFromValue(cx,args.thisv(),&owner,&state)) return false;
  if (!state) { JS_ReportErrorASCII(cx,"close requires a native listener");return false; }
  if (!state->closing && !state->closeCompleted) {
    JSAutoRealm realm(cx,owner);RootedValue callback(cx,args.get(0));
    if (!JS_WrapValue(cx,&callback)) return false;
    if (callback.isObject() && JS::IsCallable(&callback.toObject()))
      JS::SetReservedSlot(owner,ListenerCloseCallback,callback);
    state->BeginClose();
  }
  args.rval().setUndefined();return true;
}
static bool KandeloListenerRef(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc,vp);RootedObject owner(cx);KandeloListenerState* state;
  if (!KandeloListenerFromValue(cx,args.thisv(),&owner,&state)) return false;
  if (!state) { JS_ReportErrorASCII(cx,"ref requires a native listener");return false; }
  if (!state->initializing && !state->closeCompleted) state->listener.Ref(true);args.rval().setUndefined();return true;
}
static bool KandeloListenerUnref(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc,vp);RootedObject owner(cx);KandeloListenerState* state;
  if (!KandeloListenerFromValue(cx,args.thisv(),&owner,&state)) return false;
  if (!state) { JS_ReportErrorASCII(cx,"unref requires a native listener");return false; }
  if (!state->initializing && !state->closeCompleted) state->listener.Ref(false);args.rval().setUndefined();return true;
}
static bool KandeloListenerHasRef(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc,vp);RootedObject owner(cx);KandeloListenerState* state;
  if (!KandeloListenerFromValue(cx,args.thisv(),&owner,&state)) return false;
  if (!state) { JS_ReportErrorASCII(cx,"hasRef requires a native listener");return false; }
  args.rval().setBoolean(!state->initializing && !state->closeCompleted && state->listener.Referenced());return true;
}
static bool KandeloListenerAsyncId(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args=CallArgsFromVp(argc,vp);RootedObject owner(cx);KandeloListenerState* state;
  if (!KandeloListenerFromValue(cx,args.thisv(),&owner,&state)) return false;
  args.rval().setNumber(state && !state->retired?state->id:-1);return true;
}
static bool KandeloListenerResourceInfo(JSContext* cx, HandleObject owner,
                                       MutableHandleValue result) {
  RootedValue value(cx,ObjectValue(*owner));RootedObject actual(cx);KandeloListenerState* state;
  if (!KandeloListenerFromValue(cx,value,&actual,&state)) return false;
  if (!state) { JS_ReportErrorASCII(cx,"Invalid native listener resource");return false; }
  JS::RootedValueArray<5> entries(cx);
  entries[0].setNumber(state->id);entries[1].setNumber(state->trigger);
  entries[2].set(JS::GetReservedSlot(actual,ListenerFrame));
  // TCPWrap::New selects TCPSERVERWRAP for TCP(SERVER); accepted TCP(SOCKET)
  // is independently initialized by the existing TCPWRAP owner.
  RootedString provider(cx,JS_NewStringCopyZ(cx,"TCPSERVERWRAP"));if (!provider) return false;
  entries[3].setString(provider);entries[4].setObject(*actual);
  for (size_t i=0;i<5;++i) if (!JS_WrapValue(cx,entries[i])) return false;
  RootedObject array(cx,JS::NewArrayObject(cx,entries));if (!array) return false;
  result.setObject(*array);return true;
}
static bool KandeloListenerInitialize(JSContext* cx, HandleObject owner,
                                       KandeloListenerState* state) {
  RootedValue frame(cx);
  if (!cx->kandeloAsyncProperty("frame",&frame) ||
      !cx->getKandeloDefaultTriggerAsyncId(&state->trigger) || !JS_WrapValue(cx,&frame)) return false;
  state->lifetime=js::shell::KandeloGetNativeAsyncState(cx);if (!state->lifetime) return false;
  state->lifetime->Retain();state->id=cx->allocateKandeloAsyncId();
  JS::SetReservedSlot(owner,ListenerFrame,frame);
  return cx->notifyKandeloAsyncLifecycle("native:init",owner,frame);
}
// Ordinary loop continuation retires a closed native handle only after every
// already admitted accept has relinquished its real owner root. No JS, fallible
// rearming, or destruction hook is run by BeginClose or a GC finalizer.
static int KandeloDispatchListenerOwners(JSContext* cx) {
  if (cx->isExceptionPending()) return 0;
  for (auto* state=gKandeloListeners;state;state=state->next) {
    if (state->cx!=cx || !state->closing || state->callbackActive || state->initializing || state->accepts || !state->liveRoot) continue;
    RootedObject owner(cx,*state->liveRoot);JSAutoRealm realm(cx,owner);
    state->closeCompleted=true;state->callbackActive=true;
    auto retire=mozilla::MakeScopeExit([&] {
      JS::SetReservedSlot(owner,ListenerCloseCallback,UndefinedValue());
      JS::SetReservedSlot(owner,ListenerFrame,UndefinedValue());
      state->closing=false;state->callbackActive=false;state->Retire();state->liveRoot.reset();state->RefreshMemory();
    });
    RootedValue callback(cx,JS::GetReservedSlot(owner,ListenerCloseCallback));
    if (callback.isObject() && JS::IsCallable(&callback.toObject())) {
      RootedValue frame(cx,JS::GetReservedSlot(owner,ListenerFrame)),ignored(cx);
      KandeloNativeCallbackScope scope(cx,owner,frame);
      if (!scope.Enter()) return -1;
      if (scope.Stopped()) return scope.Close()?0:-1;
      const bool called=JS_CallFunctionValue(cx,owner,callback,JS::HandleValueArray::empty(),&ignored);
      if (!(called?scope.Close():scope.Fail())) return -1;
    }
    return 1; // No raw registry next pointer crosses callback/job reentry.
  }
  return 0;
}
static bool KandeloListenerOwnersHaveReferences(JSContext* cx) {
  for (auto* state=gKandeloListeners;state;state=state->next) {
    if (state->cx!=cx || state->detached) continue;
    if (state->closing || (!state->listener.Closed() && state->listener.Fd()>=0 && state->listener.Referenced())) return true;
  }
  return false;
}
static bool KandeloCreateListener(JSContext* cx, MutableHandleObject object,
                                   KandeloListenerState** result) {
  if (gKandeloListenerGeneration == UINT64_MAX) {
    JS_ReportErrorASCII(cx,"Listener owner generation exhausted");return false;
  }
  object.set(JS_NewObjectWithGivenProto(cx,&KandeloListenerClass,nullptr));
  if (!object) return false;
  std::unique_ptr<KandeloListenerState> preparing;
  try {
    preparing = std::make_unique<KandeloListenerState>(cx,++gKandeloListenerGeneration);
    preparing->claims.Add(preparing->allocation.Handle(),KandeloNativeMemoryOwner(cx));
    preparing->liveRoot=std::make_unique<PersistentRootedObject>(cx,object);preparing->RefreshMemory();
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx);return false; }
  auto* state = preparing.release();
  JS::SetReservedSlot(object,0,PrivateValue(state));
  state->next = gKandeloListeners;gKandeloListeners = state;
  bool initialized=false;
  auto abandon=mozilla::MakeScopeExit([&] { state->initializing=false;if (!initialized) state->BeginClose(); });
  static const JSFunctionSpec methods[]={
    JS_FN("close",KandeloListenerClose,0,0),JS_FN("ref",KandeloListenerRef,0,0),
    JS_FN("unref",KandeloListenerUnref,0,0),JS_FN("hasRef",KandeloListenerHasRef,0,0),
    JS_FN("getAsyncId",KandeloListenerAsyncId,0,0),JS_FS_END};
  // TCPWrap's actual instance field is installed before init hooks and is
  // consumed by the owning connection dispatcher, not a metadata placeholder.
  if (!JS_DefineFunctions(cx,object,methods) ||
      !JS_DefineProperty(cx,object,"onconnection",NullHandleValue,JSPROP_ENUMERATE) ||
      !KandeloListenerInitialize(cx,object,state)) return false;
  initialized=true;*result=state;return true;
}
// Install the actual native onconnection consumer. Its receiver and async
// resource remain this retained TCPSERVERWRAP, never the public Server facade.
static bool KandeloNativeListenerStart(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args=CallArgsFromVp(argc,vp);RootedObject owner(cx);KandeloListenerState* state;
  if (!KandeloListenerFromValue(cx,args.get(0),&owner,&state)) return false;
  if (!state || !args.get(1).isObject() || !JS::IsCallable(&args[1].toObject())) {
    JS_ReportErrorASCII(cx,"Listener callback requires an actual listener and callable");return false;
  }
  JSAutoRealm realm(cx,owner);RootedValue callback(cx,args[1]);
  if (!JS_WrapValue(cx,&callback) || !JS_SetProperty(cx,owner,"onconnection",callback)) return false;
  // Property publication can run a real setter that closes the listener.
  if (state->initializing || state->listener.Closed() || state->closeCompleted) {
    args.rval().setInt32(-EBADF);return true;
  }
  state->accepting=true;args.rval().setInt32(0);return true;
}
static bool KandeloNativeListenerFd(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc,vp);RootedObject owner(cx);KandeloListenerState* state;
  if (!KandeloListenerFromValue(cx,args.get(0),&owner,&state)) return false;
  if (!state) { JS_ReportErrorASCII(cx,"Listener fd requires its actual owner");return false; }
  args.rval().setInt32(state->listener.Fd());return true;
}
static void KandeloShutdownListeners(JSContext* cx) {
  for (auto* state = gKandeloListeners;state;state = state->next) {
    if (state->cx == cx) {
      state->accepting=false;state->listener.Close();state->detached=true;state->closing=false;state->closeCompleted=true;
      if (state->liveRoot) {
        JS::SetReservedSlot(*state->liveRoot,ListenerFrame,UndefinedValue());
        JS::SetReservedSlot(*state->liveRoot,ListenerCloseCallback,UndefinedValue());
      }
      state->Retire();state->liveRoot.reset();state->RefreshMemory();
    }
  }
}
} // namespace
