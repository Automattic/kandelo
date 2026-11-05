#include "kandelo-node-terminal-operations.h"
namespace js::shell {
struct KandeloTerminalLease {
  KandeloNativeAsyncState* state;
  KandeloTerminalLease* previous = nullptr;
  KandeloTerminalLease* next;
  kandelo::terminal::BorrowedInputMode mode;
  explicit KandeloTerminalLease(KandeloNativeAsyncState* state)
      : state(state), next(state->terminalLeases) {
    state->Retain();if (next) next->previous = this;state->terminalLeases = this;
  }
  ~KandeloTerminalLease() {
    mode.Close();
    if (previous) previous->next = next;else state->terminalLeases = next;
    if (next) next->previous = previous;
    state->Release();
  }
};
static void KandeloShutdownTerminalLeases(KandeloNativeAsyncState* state) {
  for (auto* lease = state->terminalLeases; lease; lease = lease->next) lease->mode.Close();
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
static bool KandeloTerminalDispatch(JSContext* cx, const CallArgs& args,
                                    const char* name, MutableHandleValue value, int* error) {
  if (strcmp(name, "tty-size") == 0 || strcmp(name, "tty-open") == 0) {
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
    *error = lease->mode.Open(int(fd));
    if (*error) { js_delete(lease);return true; }
    JS::AddAssociatedMemory(object, sizeof(*lease), JS::MemoryUse::Embedding3);
    JS::SetReservedSlot(object, 0, PrivateValue(lease));value.setObject(*object);return true;
  }
  if (!args.get(1).isObject() || JS::GetClass(&args[1].toObject()) != &KandeloTerminalClass ||
      JS::GetReservedSlot(&args[1].toObject(), 0).isUndefined()) {
    JS_ReportErrorASCII(cx, "Terminal operation requires an actual mode lease");return false;
  }
  auto* lease = static_cast<js::shell::KandeloTerminalLease*>(JS::GetReservedSlot(&args[1].toObject(), 0).toPrivate());
  if (strcmp(name, "tty-close") == 0) { lease->mode.Close();return true; }
  if (strcmp(name, "tty-mode") == 0) {
    int64_t mode;if (!KandeloFsInteger(cx, args.get(2), 0, 3, &mode)) return false;
    *error = lease->mode.SetMode(int(mode));return true;
  }
  JS_ReportErrorASCII(cx, "Unknown terminal operation");return false;
}
}  // namespace
