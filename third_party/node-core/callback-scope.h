// Native callback-scope policy, adapted from pinned src/api/callback.cc.
// Host supplies actual hooks, async context, stopping state and task queues.
#ifndef KANDELO_NODE_CALLBACK_SCOPE_H
#define KANDELO_NODE_CALLBACK_SCOPE_H
#include <cassert>
namespace kandelo::async {
// Real JS entry points already own the outer native callback depth, even
// where the timer/tick/job's resource hooks are dispatched by its JS owner.
class CallbackEntryDepth {
  unsigned* depth_;
 public:
  explicit CallbackEntryDepth(unsigned* depth) : depth_(depth) { if (depth_) ++*depth_; }
  CallbackEntryDepth(const CallbackEntryDepth&) = delete;
  CallbackEntryDepth& operator=(const CallbackEntryDepth&) = delete;
  bool Ready() const { return depth_ != nullptr; }
  void Close() { if (depth_) { assert(*depth_ > 0); --*depth_; depth_ = nullptr; } }
  ~CallbackEntryDepth() { Close(); }
};
template<class Host> class CallbackScope {
  Host& host_;
  bool counted_ = false, entered_ = false, closed_ = false, result_ = false;
 public:
  explicit CallbackScope(Host& host) : host_(host) {}
  CallbackScope(const CallbackScope&) = delete;
  CallbackScope& operator=(const CallbackScope&) = delete;
  bool Stopped() const { return host_.Stopping() && !host_.HasError(); }
  bool Enter() {
    assert(!counted_ && !closed_);
    if (!host_.Ready() || host_.HasError()) return false;
    ++host_.Depth(); counted_ = true;
    if (host_.Stopping()) return false;
    entered_ = host_.Before();
    return entered_ && !host_.Stopping();
  }
  bool Close(bool succeeded = true) {
    if (closed_) return result_;
    closed_ = true;
    bool ok = counted_ && entered_ && succeeded && !host_.Stopping();
    if (ok) ok = host_.After();
    // Restoration never invokes user JS, including a throwing/fatal hook.
    if (counted_) host_.Restore();
    if (!ok || host_.Stopping()) return result_ = Stopped();
    // Keep depth entered while draining: a nested native callback must not
    // recursively checkpoint the same tick/job queues or retire its caller.
    if (host_.Depth() > 1) return result_ = true;
    const bool completed = host_.Checkpoint();
    return result_ = completed || Stopped();
  }
  ~CallbackScope() {
    if (!closed_) Close(false);
    if (counted_) { assert(host_.Depth() > 0); --host_.Depth(); }
  }
};
}  // namespace kandelo::async
#endif
