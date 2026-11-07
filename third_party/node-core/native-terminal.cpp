#include "kandelo-node-terminal-operations.h"
#include "js/Realm.h"
#include "js/Wrapper.h"
#include "js/experimental/TypedData.h"
namespace js::shell {
struct KandeloTerminalLease {
  KandeloNativeAsyncState* state;
  KandeloTerminalLease* previous = nullptr;
  KandeloTerminalLease* next;
  kandelo::terminal::BorrowedInputMode mode;
  kandelo::terminal::OutputHandle output;
  bool outputOwner = false;
  explicit KandeloTerminalLease(KandeloNativeAsyncState* state)
      : state(state), next(state->terminalLeases) {
    state->Retain();if (next) next->previous = this;state->terminalLeases = this;
  }
  ~KandeloTerminalLease() {
    mode.Close();output.Close();
    if (previous) previous->next = next;else state->terminalLeases = next;
    if (next) next->previous = previous;
    state->Release();
  }
};
static void KandeloShutdownTerminalLeases(KandeloNativeAsyncState* state) {
  for (auto* lease = state->terminalLeases; lease; lease = lease->next) { lease->mode.Close();lease->output.Close(); }
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
  JSCLASS_HAS_RESERVED_SLOTS(1) | JSCLASS_FOREGROUND_FINALIZE, &KandeloTerminalOps};
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
  if (strcmp(name, "tty-size") == 0 || strcmp(name, "tty-open") == 0 || strcmp(name, "tty-output-open") == 0) {
    int64_t fd;if (!KandeloFsInteger(cx, args.get(1), INT32_MIN, INT32_MAX, &fd)) return false;
    if (strcmp(name, "tty-size") == 0) {
      std::array<unsigned, 2> dimensions{};*error = kandelo::terminal::WindowSize(int(fd), &dimensions);
      if (*error) return true;
      JS::RootedValueArray<2> fields(cx);fields[0].setNumber(dimensions[0]);fields[1].setNumber(dimensions[1]);
      RootedObject array(cx, JS::NewArrayObject(cx, fields));if (!array) return false;
      value.setObject(*array);return true;
    }
    auto* state = js::shell::KandeloGetNativeAsyncState(cx);if (!state) return false;
    RootedObject object(cx, JS_NewObject(cx, &KandeloTerminalClass));if (!object) return false;
    auto* lease = js_new<js::shell::KandeloTerminalLease>(state);
    if (!lease) { JS_ReportOutOfMemory(cx);return false; }
    lease->outputOwner = strcmp(name, "tty-output-open") == 0;
    *error = lease->outputOwner ? lease->output.Open(int(fd)) : lease->mode.Open(int(fd));
    if (*error) { js_delete(lease);return true; }
    JS::AddAssociatedMemory(object, sizeof(*lease), JS::MemoryUse::Embedding3);
    JS::SetReservedSlot(object, 0, PrivateValue(lease));value.setObject(*object);return true;
  }
  RootedObject leaseObject(cx);
  if (!KandeloTerminalCheckedObject(cx, args.get(1), &leaseObject)) return false;
  if (!leaseObject || JS::GetClass(leaseObject) != &KandeloTerminalClass ||
      JS::GetReservedSlot(leaseObject, 0).isUndefined()) {
    JS_ReportErrorASCII(cx, "Terminal operation requires an actual terminal lease");return false;
  }
  // Keep the actual native owner alive while later view authority checks may
  // reenter. Do not cache its fd: a reentrant close must produce real EBADF.
  auto* lease = static_cast<js::shell::KandeloTerminalLease*>(JS::GetReservedSlot(leaseObject, 0).toPrivate());
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
    lease->output.Close();return true;
  }
  if (lease->outputOwner) { JS_ReportErrorASCII(cx, "Terminal mode requires an input mode owner");return false; }
  if (strcmp(name, "tty-close") == 0) { lease->mode.Close();return true; }
  if (strcmp(name, "tty-mode") == 0) {
    int64_t mode;if (!KandeloFsInteger(cx, args.get(2), 0, 3, &mode)) return false;
    *error = lease->mode.SetMode(int(mode));return true;
  }
  JS_ReportErrorASCII(cx, "Unknown terminal operation");return false;
}
}  // namespace
