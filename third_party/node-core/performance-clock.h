// Process origin is captured once at engine main entry, before JS/worker boot.
// Worker contexts read the same immutable origin; Date/test clocks cannot move it.
#ifndef KANDELO_NODE_PERFORMANCE_CLOCK_H
#define KANDELO_NODE_PERFORMANCE_CLOCK_H
#include <cerrno>
#include "kandelo-node-monotonic-clock.h"
namespace kandelo::clock {
struct PerformanceOrigin {
  uint64_t monotonic = 0;
  double unixMilliseconds = 0;
  bool initialized = false;
  uint64_t nativeEntry = 0;
  bool nativeEntryRecorded = false;
  int Initialize() {
    if (initialized) { errno = EALREADY; return -1; }
    timespec wall;
    if (clock_gettime(CLOCK_REALTIME, &wall) != 0 || Nanoseconds(&monotonic) != 0) return -1;
    unixMilliseconds = double(wall.tv_sec) * 1000 + double(wall.tv_nsec) / 1e6;
    initialized = true;
    return 0;
  }
  int MarkNativeEntry() {
    if (!initialized || nativeEntryRecorded) { errno = EINVAL; return -1; }
    if (Nanoseconds(&nativeEntry) != 0) return -1;
    if (nativeEntry < monotonic) { errno = EIO; return -1; }
    nativeEntryRecorded = true; return 0;
  }
  int Now(double* milliseconds) const {
    if (!initialized) { errno = EINVAL; return -1; }
    uint64_t current;
    if (Nanoseconds(&current) != 0) return -1;
    if (current < monotonic) { errno = EIO; return -1; }
    *milliseconds = double(current - monotonic) / 1e6;
    return 0;
  }
};
// Owned by one ShellContext and accessed only by its event-loop thread.
// Measure actual provider-wait intervals; synchronous work/blocking JS remains
// active time, matching ELU's distinction from CPU usage. Clock failures stay
// observable and never become zero samples.
class EventLoopClock {
 public:
  enum class Milestone { Environment, BootstrapComplete, LoopExit, V8Start };
  int MarkEnvironment() { return Capture(environment_); }
  int MarkBootstrapComplete() {
    if (!environment_.recorded) { errno = EINVAL; return -1; }
    return Capture(bootstrap_);
  }
  int MarkLoopExit() {
    // No loop exit exists when explicit/synchronous exit never entered it.
    return started_ ? Capture(exit_) : 0;
  }
  int ReadMilestone(Milestone kind, uint64_t* stamp, bool* recorded) const {
    if (error_) { errno = error_; return -1; }
    const Stamp* value = kind == Milestone::Environment ? &environment_ :
        kind == Milestone::BootstrapComplete ? &bootstrap_ :
        kind == Milestone::LoopExit ? &exit_ : &v8_;
    *stamp = value->nanoseconds; *recorded = value->recorded; return 0;
  }
  void Enter() {
    if (error_ || started_) return;
    if (Nanoseconds(&started_) != 0) error_ = errno;
  }
  void BeginIdle() {
    if (error_) return;
    if (!started_ || waiting_) { error_ = EINVAL; return; }
    if (Nanoseconds(&idleStart_) != 0) { error_ = errno; return; }
    waiting_ = true;
  }
  void EndIdle() {
    if (error_) return;
    if (!waiting_) { error_ = EINVAL; return; }
    uint64_t end;
    if (Nanoseconds(&end) != 0) { error_ = errno; return; }
    waiting_ = false;
    if (end < idleStart_) { error_ = EIO; return; }
    if (UINT64_MAX - idle_ < end - idleStart_) {
      error_ = EOVERFLOW; return;
    }
    idle_ += end - idleStart_;
  }
  int Read(uint64_t* start, uint64_t* idle) const {
    if (error_) { errno = error_; return -1; }
    uint64_t elapsed = idle_;
    if (waiting_) {
      uint64_t now;
      if (Nanoseconds(&now) != 0) return -1;
      if (now < idleStart_) { errno = EIO; return -1; }
      if (UINT64_MAX - elapsed < now - idleStart_) {
        errno = EOVERFLOW; return -1;
      }
      elapsed += now - idleStart_;
    }
    *start = started_; *idle = elapsed; return 0;
  }
 private:
  struct Stamp { uint64_t nanoseconds = 0; bool recorded = false; };
  Stamp environment_, bootstrap_, exit_;
  // This SpiderMonkey embedding has no V8 initialization transition. Like
  // Node when v8_initialized is false, its legacy field stays genuinely unset.
  Stamp v8_;
  int Capture(Stamp& stamp) {
    if (error_) { errno = error_; return -1; }
    if (stamp.recorded) return 0;
    uint64_t now;
    if (Nanoseconds(&now) != 0) { error_ = errno; return -1; }
    if (environment_.recorded && now < environment_.nanoseconds) {
      error_ = errno = EIO; return -1;
    }
    stamp.nanoseconds = now; stamp.recorded = true; return 0;
  }
  uint64_t started_ = 0;
  uint64_t idleStart_ = 0;
  uint64_t idle_ = 0;
  int error_ = 0;
  bool waiting_ = false;
};
}  // namespace kandelo::clock
#endif
