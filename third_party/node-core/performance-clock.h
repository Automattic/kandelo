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
}  // namespace kandelo::clock
#endif
