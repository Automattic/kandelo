// Real native listener lifetime; no public TCPWRAP/AsyncWrap metadata facade.
#include "kandelo-node-listener-owner.h"
#include "js/Wrapper.h"
namespace {
struct KandeloListenerState;
static thread_local KandeloListenerState* gKandeloListeners = nullptr;
static thread_local uint64_t gKandeloListenerGeneration = 0;
struct KandeloListenerState {
  JSContext* const cx;
  KandeloListenerState* next = nullptr;
  kandelo::listener::Owner listener;
  bool detached = false;
  kandelo::memory::Allocation allocation{sizeof(KandeloListenerState)};
  kandelo::memory::Claims claims;
  KandeloListenerState(JSContext* cx, uint64_t generation)
      : cx(cx), listener(generation) {}
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
static const JSClass KandeloListenerClass = {"KandeloListener",
  JSCLASS_HAS_RESERVED_SLOTS(1) | JSCLASS_FOREGROUND_FINALIZE,&KandeloListenerOps};
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
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx);return false; }
  auto* state = preparing.release();
  JS::SetReservedSlot(object,0,PrivateValue(state));
  state->next = gKandeloListeners;gKandeloListeners = state;
  *result = state;return true;
}
static bool KandeloNativeListenerFd(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc,vp);RootedObject owner(cx);KandeloListenerState* state;
  if (!KandeloListenerFromValue(cx,args.get(0),&owner,&state)) return false;
  if (!state) { JS_ReportErrorASCII(cx,"Listener fd requires its actual owner");return false; }
  args.rval().setInt32(state->listener.Fd());return true;
}
static void KandeloShutdownListeners(JSContext* cx) {
  for (auto* state = gKandeloListeners;state;state = state->next) {
    if (state->cx == cx) { state->listener.Close();state->detached = true; }
  }
}
} // namespace
