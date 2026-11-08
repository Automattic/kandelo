// Shared native resource callback scope. Included after native-async.cpp and
// before the codec/filesystem owners. Task draining is defined in shell/js.cpp.
#include "kandelo-node-callback-scope.h"
static bool KandeloPerformCallbackCheckpoint(JSContext* cx);
namespace {
class KandeloNativeJsEntryScope {
  js::shell::KandeloNativeAsyncState* lifetime_;
  kandelo::async::CallbackEntryDepth depth_;
 public:
  explicit KandeloNativeJsEntryScope(JSContext* cx)
      : lifetime_(js::shell::KandeloGetNativeAsyncState(cx)),
        depth_(lifetime_ && !cx->isExceptionPending() ? &lifetime_->callbackDepth : nullptr) {
    if (lifetime_) lifetime_->Retain();
  }
  ~KandeloNativeJsEntryScope() { depth_.Close(); if (lifetime_) lifetime_->Release(); }
  bool Ready() const { return depth_.Ready(); }
};
class KandeloCallbackHost {
  JSContext* cx_;
  RootedObject resource_;
  JSAutoRealm realm_;
  RootedValue frame_, prior_;
  js::shell::KandeloNativeAsyncState* lifetime_;
  bool zeroIds_;
  bool skipTaskQueues_;
  uint64_t epoch_;
  size_t executionDepth_;
 public:
  KandeloCallbackHost(JSContext* cx, HandleObject resource, HandleValue frame, bool zeroIds = false, bool skipTaskQueues = false)
      : cx_(cx), resource_(cx, resource), realm_(cx, resource),
        frame_(cx, frame), prior_(cx, cx->kandeloAsyncContext()),
        lifetime_(js::shell::KandeloGetNativeAsyncState(cx)), zeroIds_(zeroIds), skipTaskQueues_(skipTaskQueues),
        epoch_(js::shell::KandeloReadExecutionEpoch(cx)),
        executionDepth_(lifetime_ ? lifetime_->execution.Depth() : 0) {
    if (lifetime_) lifetime_->Retain();
  }
  ~KandeloCallbackHost() { if (lifetime_) lifetime_->Release(); }
  bool Ready() const { return lifetime_ != nullptr; }
  unsigned& Depth() { return lifetime_->callbackDepth; }
  bool Stopping() const { return GetShellContext(cx_)->quitting; }
  bool HasError() const { return cx_->isExceptionPending(); }
  bool Before() { return cx_->notifyKandeloAsyncLifecycle(
      zeroIds_ ? "callback:zero" : "before", resource_, frame_); }
  bool After() { return cx_->notifyKandeloAsyncLifecycle(
      zeroIds_ ? "callback:zero:after" : "after", resource_, frame_); }
  bool Recover() { return KandeloRecoverUncaughtException(cx_); }
  void Restore() {
    // The pinned fatal handler can clear every active execution record.
    // Neither this scope nor an outer one may resurrect that captured state.
    if (epoch_ != js::shell::KandeloReadExecutionEpoch(cx_)) return;
    if (lifetime_ && lifetime_->execution.Depth() == executionDepth_ + 1) {
      // Nested/synchronous failure propagates to its JavaScript caller. It
      // closes this native ID without After; only an outer event boundary may
      // dispatch uncaughtException after the caller's try/finally unwinds.
      const auto popped = lifetime_->execution.Pop(lifetime_->execution.Id(), [](const auto&) {});
      MOZ_RELEASE_ASSERT(popped != js::shell::KandeloExecutionStack::PopResult::WrongId);
    }
    cx_->kandeloAsyncContext() = prior_;
  }
  bool Call(JS::HandleValue callback, const JS::HandleValueArray& arguments,
            JS::MutableHandleValue result) {
    // This is the MakeCallback invocation seam, not InternalCallbackScope's
    // direct resolver path. Actual nonzero owners retain existing hook logic.
    if (lifetime_->execution.Id() != 0 || !lifetime_->domainTrampoline.initialized() ||
        !lifetime_->domainTrampoline)
      return JS::Call(cx_, resource_, callback, arguments, result);
    RootedValue gate(cx_, ObjectValue(*lifetime_->domainTrampolineGate));
    RootedValue trampoline(cx_, ObjectValue(*lifetime_->domainTrampoline));
    if (!JS_WrapValue(cx_, &gate) || !JS_WrapValue(cx_, &trampoline)) return false;
    RootedValue active(cx_);
    if (!JS::Call(cx_, resource_, gate, JS::HandleValueArray::empty(), &active)) return false;
    if (!JS::ToBoolean(active)) return JS::Call(cx_, resource_, callback, arguments, result);
    RootedValueVector values(cx_);
    if (!values.append(callback)) { JS_ReportOutOfMemory(cx_);return false; }
    for (size_t i = 0; i < arguments.length(); ++i)
      if (!values.append(arguments[i])) { JS_ReportOutOfMemory(cx_);return false; }
    return JS::Call(cx_, resource_, trampoline, values, result);
  }
  bool Checkpoint() { return skipTaskQueues_ || KandeloPerformCallbackCheckpoint(cx_); }
};
class KandeloNativeCallbackScope {
  KandeloCallbackHost host_;
  kandelo::async::CallbackScope<KandeloCallbackHost> scope_;
 public:
  KandeloNativeCallbackScope(JSContext* cx, HandleObject resource, HandleValue frame, bool skipTaskQueues = false)
      : host_(cx, resource, frame, false, skipTaskQueues), scope_(host_) {}
  bool Enter() { return scope_.Enter(); }
  bool Stopped() const { return scope_.Stopped(); }
  bool Call(JS::HandleValue callback, const JS::HandleValueArray& arguments,
            JS::MutableHandleValue result) { return host_.Call(callback, arguments, result); }
  bool Close() { return scope_.Close(); }
  bool Fail() { return scope_.Close(false); }
};
// InternalCallbackScope with IDs {0,0}: a real plain execution resource and
// default frame, no AsyncWrap lifecycle, shared depth/retirement/checkpoint.
class KandeloNativeInternalCallbackScope {
  KandeloCallbackHost host_;
  kandelo::async::CallbackScope<KandeloCallbackHost> scope_;
 public:
  KandeloNativeInternalCallbackScope(JSContext* cx, HandleObject resource)
      : host_(cx, resource, UndefinedHandleValue, true), scope_(host_) {}
  bool Enter() { return scope_.Enter(); }
  bool Stopped() const { return scope_.Stopped(); }
  bool Close() { return scope_.Close(); }
  bool Fail() { return scope_.Close(false); }
};
}  // namespace

// Pinned node_errors.cc fatal dispatch: actual guest process, mutable public
// handler, strict-false result and distinct invalid-handler/handler-throw exits.
static bool KandeloRecoverUncaughtException(JSContext* cx) {
  auto* sc = GetShellContext(cx);
  auto* state = sc->kandeloNativeAsync;
  if (!state || !state->process.initialized() || !state->process ||
      sc->quitting || !cx->isExceptionPending()) return false;
  if (state->handlingUncaught) {
    // No recursive handler dispatch. This is our owning process failure,
    // not evidence of a browser/runtime defect.
    sc->exitCode = 7; sc->quitting = true; return false;
  }
  if (js::shell::KandeloShouldAbortOnUncaught(cx)) {
    // Like V8's abort admission guard, prevent reporting from recursively
    // dispatching another uncaught exception before the real abort completes.
    state->handlingUncaught = true;
    // This is real guest libc abort/SIGABRT, not an invented status or a
    // catchable JavaScript error. Existing pending exception remains reportable.
    { AutoReportException report(cx); }
    abort();
  }
  state->handlingUncaught = true;
  auto leave = mozilla::MakeScopeExit([&] { state->handlingUncaught = false; });
  const uint64_t epoch = state->execution.Epoch();
  const double enteringId = state->execution.Id();
  RootedValue prior(cx);
  if (auto* top = state->execution.Top()) prior = top->prior;
  JS::ExceptionStack exception(cx);
  if (!JS::StealPendingExceptionStack(cx, &exception)) return false;
  RootedObject process(cx, state->process);
  JSAutoRealm realm(cx, process);
  RootedValue handler(cx), result(cx);
  auto stop = [&](int status, bool original) {
    if (original) JS::SetPendingExceptionStack(cx, exception);
    { AutoReportException report(cx); }
    // Reporters have their own standalone-shell status. The actual Node
    // fatal-dispatch status is authoritative after that report.
    sc->exitCode = status; sc->quitting = true;
    js::StopDrainingJobQueue(cx); return false;
  };
  if (!JS_GetProperty(cx, process, "_fatalException", &handler)) {
    // The exact native getter-throw control currently exits zero after V8
    // schedules a superseding exception. Preserve the actual SpiderMonkey
    // getter exception here; matching that dispatch boundary is an unresolved
    // deviation, not permission to discard an error to manufacture a pass.
    return stop(7, false);
  } else {
    if (!handler.isObject() || !JS::IsCallable(&handler.toObject())) return stop(6, true);
    JS::RootedValueArray<2> arguments(cx);
    arguments[0].set(exception.exception()); arguments[1].setBoolean(false);
    if (!JS_WrapValue(cx, arguments[0])) return false;
    if (!JS_CallFunctionValue(cx, process, handler, arguments, &result)) {
      if (sc->quitting) return false;
      return stop(7, false);
    }
    if (result.isFalse()) {
      RootedValue status(cx);
      if (!JS_GetProperty(cx, process, "exitCode", &status)) return stop(7, false);
      return stop(status.isInt32() ? status.toInt32() : 1, true);
    }
  }
  // A user override may handle without running the standard JS fatal handler.
  // Close this actual entering scope without inventing an after hook. The
  // standard handler already drained/cleared and changed the epoch itself.
  if (epoch == state->execution.Epoch() && !state->execution.Empty()) {
    const auto popped = state->execution.Pop(enteringId, [](const auto&) {});
    if (popped == js::shell::KandeloExecutionStack::PopResult::WrongId) {
      JS_ReportErrorASCII(cx, "Uncaught recovery left a corrupt execution stack"); return false;
    }
    cx->kandeloAsyncContext() = prior;
  }
  return !cx->isExceptionPending() && !sc->quitting;
}
