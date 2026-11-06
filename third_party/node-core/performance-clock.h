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
  int Initialize() {
    if (initialized) { errno = EALREADY; return -1; }
    timespec wall;
    if (clock_gettime(CLOCK_REALTIME, &wall) != 0 || Nanoseconds(&monotonic) != 0) return -1;
    unixMilliseconds = double(wall.tv_sec) * 1000 + double(wall.tv_nsec) / 1e6;
    initialized = true;
    return 0;
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
  uint64_t started_ = 0;
  uint64_t idleStart_ = 0;
  uint64_t idle_ = 0;
  int error_ = 0;
  bool waiting_ = false;
};
}  // namespace kandelo::clock
#endif
