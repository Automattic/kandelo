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
 public:
  KandeloCallbackHost(JSContext* cx, HandleObject resource, HandleValue frame, bool zeroIds = false)
      : cx_(cx), resource_(cx, resource), realm_(cx, resource),
        frame_(cx, frame), prior_(cx, cx->kandeloAsyncContext()),
        lifetime_(js::shell::KandeloGetNativeAsyncState(cx)), zeroIds_(zeroIds) {
    if (lifetime_) lifetime_->Retain();
  }
  ~KandeloCallbackHost() { if (lifetime_) lifetime_->Release(); }
  bool Ready() const { return lifetime_ != nullptr; }
  unsigned& Depth() { return lifetime_->callbackDepth; }
  bool Stopping() const { return GetShellContext(cx_)->quitting; }
  bool HasError() const { return cx_->isExceptionPending(); }
  bool Before() { return cx_->notifyKandeloAsyncLifecycle(
      zeroIds_ ? "callback:zero" : "before", resource_, frame_); }
  bool After() { return zeroIds_ || cx_->notifyKandeloAsyncLifecycle("after", resource_, frame_); }
  void Restore() { cx_->kandeloAsyncContext() = prior_; }
  bool Checkpoint() { return KandeloPerformCallbackCheckpoint(cx_); }
};
class KandeloNativeCallbackScope {
  KandeloCallbackHost host_;
  kandelo::async::CallbackScope<KandeloCallbackHost> scope_;
 public:
  KandeloNativeCallbackScope(JSContext* cx, HandleObject resource, HandleValue frame)
      : host_(cx, resource, frame), scope_(host_) {}
  bool Enter() { return scope_.Enter(); }
  bool Stopped() const { return scope_.Stopped(); }
  bool Close() { return scope_.Close(); }
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
};
}  // namespace
