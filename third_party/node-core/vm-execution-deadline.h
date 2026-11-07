#ifndef KANDELO_NODE_VM_EXECUTION_DEADLINE_H
#define KANDELO_NODE_VM_EXECUTION_DEADLINE_H

#include <atomic>
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <thread>

namespace kandelo::vm {
// Owned by a synchronous engine invocation. Cancel joins before the supplied
// context can retire; the worker only requests an interrupt, never enters JS.
class ExecutionWatchdog {
 public:
  using Request = void (*)(void*) noexcept;

 private:
  using Clock = std::chrono::steady_clock;
  static_assert(Clock::is_steady);
  const Clock::time_point deadline_;
  Request request_;
  void* context_;
  std::mutex mutex_;
  std::condition_variable wake_;
  bool cancelled_ = false;
  std::atomic<bool> expired_{false};
  std::atomic<bool> failed_{false};
  std::thread thread_;

  void Run() noexcept {
    try {
      std::unique_lock lock(mutex_);
      if (wake_.wait_until(lock, deadline_, [&] { return cancelled_; })) return;
      expired_.store(true, std::memory_order_release);
      while (!cancelled_) {
        lock.unlock();
        request_(context_);
        lock.lock();
        // A native interrupt callback may reenter JS after consuming the first
        // request. Keep the expired owner interruptible until Cancel joins.
        wake_.wait_for(lock, std::chrono::milliseconds(1), [&] { return cancelled_; });
      }
    } catch (...) {
      // A real wait failure must stop execution, not manufacture a timeout.
      failed_.store(true, std::memory_order_release);
      request_(context_);
    }
  }

 public:
  ExecutionWatchdog(uint32_t milliseconds, Request request, void* context)
      : deadline_(Clock::now() + std::chrono::milliseconds(milliseconds)),
        request_(request), context_(context), thread_([this] { Run(); }) {
    assert(milliseconds && request);
  }
  ExecutionWatchdog(const ExecutionWatchdog&) = delete;
  ExecutionWatchdog& operator=(const ExecutionWatchdog&) = delete;
  ~ExecutionWatchdog() { Cancel(); }
  void Cancel() noexcept {
    {
      std::lock_guard lock(mutex_);
      cancelled_ = true;
    }
    wake_.notify_one();
    if (thread_.joinable()) thread_.join();
  }
  bool Expired() const noexcept { return expired_.load(std::memory_order_acquire); }
  bool Failed() const noexcept { return failed_.load(std::memory_order_acquire); }
  bool Triggered() const noexcept { return Expired() || Failed(); }
};

// The JS thread alone owns the frame chain. A foreign/nested VM boundary must
// not turn an outer invocation's uncatchable termination into a catchable error.
class ExecutionScope {
  inline static thread_local ExecutionScope* current_ = nullptr;
  ExecutionScope* previous_;
  void* context_;
  const ExecutionWatchdog& watchdog_;

 public:
  ExecutionScope(void* context, const ExecutionWatchdog& watchdog) noexcept
      : previous_(current_), context_(context), watchdog_(watchdog) { current_ = this; }
  ExecutionScope(const ExecutionScope&) = delete;
  ~ExecutionScope() { assert(current_ == this); current_ = previous_; }
  const ExecutionWatchdog& Watchdog() const noexcept { return watchdog_; }
  static ExecutionScope* TriggeredOwner(void* context) noexcept {
    ExecutionScope* owner = nullptr;
    for (auto* frame = current_; frame; frame = frame->previous_)
      if (frame->context_ == context && frame->watchdog_.Triggered()) owner = frame;
    return owner;
  }
};
}  // namespace kandelo::vm
#endif
