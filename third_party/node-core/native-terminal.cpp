#include "kandelo-node-terminal-operations.h"
#include "js/Realm.h"
#include "js/Wrapper.h"
#include "js/experimental/TypedData.h"
// Defined by the existing real fd/watch owner in shell/js.cpp. These helpers
// retain the opaque lease and actual read request; no numeric fd escapes to JS.
static bool KandeloTerminalRead(JSContext*, JS::HandleObject,
    js::shell::KandeloTerminalLease*, int32_t, JS::MutableHandleValue);
static bool KandeloTerminalReadControl(JSContext*, js::shell::KandeloTerminalLease*,
    JS::HandleObject, JS::HandleValue, JS::MutableHandleValue);
static bool KandeloTerminalCancelRead(JSContext*, js::shell::KandeloTerminalLease*, bool, bool*);
static bool KandeloTerminalStartRead(JSContext*, JS::HandleObject,
    js::shell::KandeloTerminalLease*, int32_t, JS::HandleValue, JS::MutableHandleValue);
static bool KandeloTerminalRefRead(js::shell::KandeloTerminalLease*, bool);
static bool KandeloTerminalStopRead(js::shell::KandeloTerminalLease*);
namespace js::shell {
struct KandeloTerminalLease {
  KandeloNativeAsyncState* state;
  JSContext* cx;
  double id = -1, trigger = -1;
  bool referenced = true, retired = false;
  void Retire() noexcept {
    if (!retired && id >= 0) { retired = true;state->Finalized(id); }
  }
  KandeloTerminalLease* previous = nullptr;
  KandeloTerminalLease* next;
  kandelo::terminal::BorrowedInputMode mode;
  kandelo::terminal::OutputHandle output;
  kandelo::terminal::InputHandle input;
  bool outputOwner = false, inputOwner = false, inputClosing = false;
  explicit KandeloTerminalLease(JSContext* cx, KandeloNativeAsyncState* state)
      : state(state), cx(cx), next(state->terminalLeases) {
    state->Retain();if (next) next->previous = this;state->terminalLeases = this;
  }
  ~KandeloTerminalLease() {
    bool cancelled;inputClosing = true;
    (void)KandeloTerminalCancelRead(nullptr, this, false, &cancelled);
    input.Close();mode.Close();output.Close();Retire();
    if (previous) previous->next = next;else state->terminalLeases = next;
    if (next) next->previous = previous;
    state->Release();
  }
};
static void KandeloShutdownTerminalLeases(KandeloNativeAsyncState* state) {
  for (auto* lease = state->terminalLeases; lease; lease = lease->next) {
    lease->inputClosing = true;bool cancelled;
    (void)KandeloTerminalCancelRead(nullptr, lease, false, &cancelled);
    lease->input.Close();lease->mode.Close();lease->output.Close();lease->Retire();
  }
}
}  // namespace js::shell
namespace {
static void KandeloTerminalFinalize(JS::GCContext*, JSObject* object) {
  const auto slot = JS::GetReservedSlot(object, 0);if (slot.isUndefined()) return;
  JS::RemoveAssociatedMemory(object, sizeof(js::shell::KandeloTerminalLease), JS::MemoryUse::Embedding3);
  js_delete(static_cast<js::shell::KandeloTerminalLease*>(slot.toPrivate()));
}
static const JSClassOps KandeloTerminalOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, KandeloTerminalFinalize,
  nullptr, nullptr, nullptr};
static const JSClass KandeloTerminalClass = {"BorrowedInputModeLease",
  JSCLASS_HAS_RESERVED_SLOTS(2) | JSCLASS_FOREGROUND_FINALIZE, &KandeloTerminalOps};
// A native I/O resource owns the actual captured terminal, frame and lifecycle.
// Mode-only borrowed leases deliberately retain their separate non-I/O brand.
static const JSClass KandeloTerminalIOClass = {"TTY",
  JSCLASS_HAS_RESERVED_SLOTS(2) | JSCLASS_FOREGROUND_FINALIZE, &KandeloTerminalOps};
static bool KandeloTerminalResourceInfo(JSContext* cx, HandleObject owner,
                                        MutableHandleValue result) {
  const auto slot = JS::GetReservedSlot(owner, 0);
  auto* lease = slot.isUndefined() ? nullptr : static_cast<js::shell::KandeloTerminalLease*>(slot.toPrivate());
  if (!lease || lease->cx != cx) { JS_ReportErrorASCII(cx, "Terminal resource is not live in this context");return false; }
  JS::RootedValueArray<5> fields(cx);
  fields[0].setNumber(lease->id);fields[1].setNumber(lease->trigger);
  fields[2].set(JS::GetReservedSlot(owner, 1));
  RootedString provider(cx, JS_NewStringCopyZ(cx, "TTYWRAP"));if (!provider) return false;
  fields[3].setString(provider);fields[4].setObject(*owner);
  for (size_t i = 0; i < 5; ++i) if (!JS_WrapValue(cx, fields[i])) return false;
  RootedObject packet(cx, JS::NewArrayObject(cx, fields));if (!packet) return false;
  result.setObject(*packet);return true;
}
static bool KandeloTerminalInitializeIO(JSContext* cx, HandleObject owner,
                                       js::shell::KandeloTerminalLease* lease) {
  RootedValue frame(cx);
  if (!cx->kandeloAsyncProperty("frame", &frame) ||
      !cx->getKandeloDefaultTriggerAsyncId(&lease->trigger)) return false;
  if (!JS_WrapValue(cx, &frame)) return false;
  lease->id = cx->allocateKandeloAsyncId();
  JS::SetReservedSlot(owner, 1, frame);
  return cx->notifyKandeloAsyncLifecycle("native:init", owner, frame);
}
static bool KandeloTerminalDeliverRead(JSContext* cx, HandleObject owner,
    HandleValue callback, int error, const uint8_t* bytes, size_t length) {
  JSAutoRealm realm(cx, owner);
  RootedValue frame(cx, JS::GetReservedSlot(owner, 1)), ignored(cx);
  JS::RootedValueArray<2> arguments(cx);
  arguments[0].setInt32(-error);
  if (!error) {
    RootedObject value(cx, KandeloNewUint8ArrayCopy(cx, bytes, length));if (!value) return false;
    arguments[1].setObject(*value);
  }
  KandeloNativeCallbackScope scope(cx, owner, frame);
  if (!scope.Enter()) return false;
  if (scope.Stopped()) return scope.Close();
  const bool called = scope.Call(callback, arguments, &ignored);
  return called ? scope.Close() : scope.Fail();
}
// Admission uses the calling realm's authority before entering an actual
// owner/view realm. A wrapper denial is the engine's real access error, never
// a generic type mismatch or an unchecked unwrap.
static bool KandeloTerminalCheckedObject(JSContext* cx, HandleValue input,
                                         MutableHandleObject actual) {
  actual.set(nullptr);
  if (!input.isObject()) return true;
  actual.set(js::CheckedUnwrapDynamic(&input.toObject(), cx));
  if (actual.get()) return true;
  if (!JS_IsExceptionPending(cx)) js::ReportAccessDenied(cx);
  return false;
}
static bool KandeloTerminalDispatch(JSContext* cx, const CallArgs& args,
                                    const char* name, MutableHandleValue value, int* error) {
  if (strcmp(name, "tty-size") == 0 || strcmp(name, "tty-open") == 0 || strcmp(name, "tty-output-open") == 0 || strcmp(name, "tty-input-open") == 0) {
    int64_t fd;if (!KandeloFsInteger(cx, args.get(1), INT32_MIN, INT32_MAX, &fd)) return false;
    if (strcmp(name, "tty-size") == 0) {
      std::array<unsigned, 2> dimensions{};*error = kandelo::terminal::WindowSize(int(fd), &dimensions);
      if (*error) return true;
      JS::RootedValueArray<2> fields(cx);fields[0].setNumber(dimensions[0]);fields[1].setNumber(dimensions[1]);
      RootedObject array(cx, JS::NewArrayObject(cx, fields));if (!array) return false;
      value.setObject(*array);return true;
    }
    auto* state = js::shell::KandeloGetNativeAsyncState(cx);if (!state) return false;
    const bool io = strcmp(name, "tty-output-open") == 0 || strcmp(name, "tty-input-open") == 0;
    RootedObject object(cx, JS_NewObject(cx, io ? &KandeloTerminalIOClass : &KandeloTerminalClass));if (!object) return false;
    auto* lease = js_new<js::shell::KandeloTerminalLease>(cx, state);
    if (!lease) { JS_ReportOutOfMemory(cx);return false; }
    lease->outputOwner = strcmp(name, "tty-output-open") == 0;
    lease->inputOwner = strcmp(name, "tty-input-open") == 0;
    *error = lease->outputOwner ? lease->output.Open(int(fd)) :
        lease->inputOwner ? lease->input.Open(int(fd)) : lease->mode.Open(int(fd));
    if (*error) { js_delete(lease);return true; }
    JS::AddAssociatedMemory(object, sizeof(*lease), JS::MemoryUse::Embedding3);
    JS::SetReservedSlot(object, 0, PrivateValue(lease));
    if (io && !KandeloTerminalInitializeIO(cx, object, lease)) {
      JS::SetReservedSlot(object, 0, UndefinedValue());
      JS::SetReservedSlot(object, 1, UndefinedValue());
      JS::RemoveAssociatedMemory(object, sizeof(*lease), JS::MemoryUse::Embedding3);
      js_delete(lease);return false;
    }
    value.setObject(*object);return true;
  }
  RootedObject leaseObject(cx);
  if (!KandeloTerminalCheckedObject(cx, args.get(1), &leaseObject)) return false;
  if (!leaseObject || (JS::GetClass(leaseObject) != &KandeloTerminalClass && JS::GetClass(leaseObject) != &KandeloTerminalIOClass) ||
      JS::GetReservedSlot(leaseObject, 0).isUndefined()) {
    JS_ReportErrorASCII(cx, "Terminal operation requires an actual terminal lease");return false;
  }
  // Keep the actual native owner alive while later view authority checks may
  // reenter. Do not cache its fd: a reentrant close must produce real EBADF.
  auto* lease = static_cast<js::shell::KandeloTerminalLease*>(JS::GetReservedSlot(leaseObject, 0).toPrivate());
  if (lease->cx != cx || lease->state->detached) {
    JS_ReportErrorASCII(cx, "Terminal owner belongs to a retired or different context");return false;
  }
  if (strcmp(name, "tty-input-start") == 0) {
    if (!lease->inputOwner || !args.get(3).isObject() || !JS::IsCallable(&args[3].toObject())) {
      JS_ReportErrorASCII(cx, "Terminal callback read requires its input owner and callback");return false;
    }
    int64_t length;if (!KandeloFsInteger(cx, args.get(2), 1, INT32_MAX, &length)) return false;
    return KandeloTerminalStartRead(cx, leaseObject, lease, int32_t(length), args.get(3), value);
  }
  if (strcmp(name, "tty-input-stop") == 0) {
    if (!lease->inputOwner) { JS_ReportErrorASCII(cx, "Terminal stop requires an input owner");return false; }
    value.setBoolean(KandeloTerminalStopRead(lease));return true;
  }
  if (strcmp(name, "tty-input-ref") == 0) {
    if (!lease->inputOwner || !args.get(2).isBoolean()) {
      JS_ReportErrorASCII(cx, "Terminal reference control requires its input owner and boolean");return false;
    }
    lease->referenced = args[2].toBoolean();
    value.setBoolean(KandeloTerminalRefRead(lease, lease->referenced));return true;
  }
  if (strcmp(name, "tty-input-read") == 0) {
    if (!lease->inputOwner) { JS_ReportErrorASCII(cx, "Terminal input requires its actual input owner");return false; }
    int64_t length;if (!KandeloFsInteger(cx, args.get(2), 1, INT32_MAX, &length)) return false;
    return KandeloTerminalRead(cx, leaseObject, lease, int32_t(length), value);
  }
  if (strcmp(name, "tty-input-control") == 0) {
    if (!lease->inputOwner) { JS_ReportErrorASCII(cx, "Terminal input requires its actual input owner");return false; }
    RootedObject promise(cx);
    if (!KandeloTerminalCheckedObject(cx, args.get(2), &promise)) return false;
    if (!promise || !(args.get(3).isBoolean() || args.get(3).isNull())) {
      JS_ReportErrorASCII(cx, "Terminal input control requires its actual read Promise and boolean/null");return false;
    }
    return KandeloTerminalReadControl(cx, lease, promise, args.get(3), value);
  }
  if (strcmp(name, "tty-input-close") == 0) {
    if (!lease->inputOwner) { JS_ReportErrorASCII(cx, "Terminal input requires its actual input owner");return false; }
    lease->inputClosing = true;bool cancelled;
    // Detach and terminally cancel the exact read before releasing its fd.
    const bool ok = KandeloTerminalCancelRead(cx, lease, true, &cancelled);
    lease->input.Close();lease->Retire();JS::SetReservedSlot(leaseObject, 1, UndefinedValue());return ok;
  }
  if (strcmp(name, "tty-output-size") == 0) {
    if (!lease->outputOwner) { JS_ReportErrorASCII(cx, "Terminal output requires an output owner");return false; }
    std::array<unsigned, 2> dimensions{};
    *error = lease->output.GetWindowSize(&dimensions);
    if (*error) return true;
    JS::RootedValueArray<2> fields(cx);fields[0].setNumber(dimensions[0]);fields[1].setNumber(dimensions[1]);
    RootedObject array(cx, JS::NewArrayObject(cx, fields));if (!array) return false;
    value.setObject(*array);return true;
  }
  if (strcmp(name, "tty-output-write") == 0) {
    if (!lease->outputOwner) {
      JS_ReportErrorASCII(cx, "Terminal output requires its actual owner and ArrayBufferView");return false;
    }
    RootedObject view(cx);
    if (!KandeloTerminalCheckedObject(cx, args.get(2), &view)) return false;
    if (!view || !JS_IsArrayBufferViewObject(view)) {
      JS_ReportErrorASCII(cx, "Terminal output requires its actual owner and ArrayBufferView");return false;
    }
    kandelo::terminal::OutputHandle::WriteResult result{};
    bool live;
    {
      // The public view APIs are nonallocating borrows. Enter the admitted
      // actual view realm first; no wrapper/security work or JS error occurs
      // while its original bytes are live through the synchronous libc write.
      JSAutoRealm realm(cx, view);
      JS::AutoCheckCannotGC nogc;
      const size_t length = JS_GetArrayBufferViewByteLength(view);
      bool shared;
      const auto* bytes = static_cast<const uint8_t*>(JS_GetArrayBufferViewData(view, &shared, nogc));
      live = !length || bytes;
      if (live) result = lease->output.Write(bytes, length);
    }
    if (!live) { JS_ReportErrorASCII(cx, "Terminal view has no backing data");return false; }
    *error = result.error;value.setNumber(double(result.transferred));return true;
  }
  if (strcmp(name, "tty-output-close") == 0) {
    if (!lease->outputOwner) { JS_ReportErrorASCII(cx, "Terminal output requires an output owner");return false; }
    lease->output.Close();lease->Retire();JS::SetReservedSlot(leaseObject, 1, UndefinedValue());return true;
  }
  if (lease->outputOwner) { JS_ReportErrorASCII(cx, "Terminal mode requires an input mode owner");return false; }
  if (strcmp(name, "tty-close") == 0) {
    if (lease->inputOwner) {
      lease->inputClosing = true;bool cancelled;
      const bool ok = KandeloTerminalCancelRead(cx, lease, true, &cancelled);
      lease->input.Close();lease->Retire();JS::SetReservedSlot(leaseObject, 1, UndefinedValue());return ok;
    }
    lease->mode.Close();return true;
  }
  if (strcmp(name, "tty-mode") == 0) {
    int64_t mode;if (!KandeloFsInteger(cx, args.get(2), 0, 3, &mode)) return false;
    *error = lease->inputOwner ? (lease->inputClosing ? -EBADF : lease->input.SetMode(int(mode))) : lease->mode.SetMode(int(mode));return true;
  }
  JS_ReportErrorASCII(cx, "Unknown terminal operation");return false;
}
}  // namespace
