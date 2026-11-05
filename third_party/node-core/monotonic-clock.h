// Actual POSIX monotonic nanoseconds. No wall-clock or JS state participates.
#ifndef KANDELO_NODE_MONOTONIC_CLOCK_H
#define KANDELO_NODE_MONOTONIC_CLOCK_H
#include <cstdint>
#include <time.h>
namespace kandelo::clock {
inline int Nanoseconds(uint64_t* value) {
  struct timespec time;
  const int result = clock_gettime(CLOCK_MONOTONIC, &time);
  if (result != 0) return result;
  *value = uint64_t(time.tv_sec) * UINT64_C(1000000000) + uint64_t(time.tv_nsec);
  return 0;
}
}
#endif
