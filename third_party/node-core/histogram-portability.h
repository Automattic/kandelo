// Portable runtime capabilities for the pinned Node histogram owner.
#ifndef KANDELO_NODE_HISTOGRAM_PORTABILITY_H_
#define KANDELO_NODE_HISTOGRAM_PORTABILITY_H_

#include <hdr/hdr_histogram.h>
#include "native-retained-memory.h"
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <functional>
#include <limits>
#include <memory>
#include <mutex>
#include <shared_mutex>
#include <time.h>
#include <vector>

namespace kandelo::histogram {
inline void HistogramInvariant(bool condition) {
  if (!condition) std::abort();
}

// A clock returns monotonic nanoseconds. It must outlive every owner using it,
// remain thread safe, and never move backwards. No JavaScript callback belongs
// here: RecordDelta and prepared numerical work can execute on native threads.
using HistogramClock = uint64_t (*)();
inline uint64_t HistogramMonotonicNow() {
  timespec now;
  HistogramInvariant(clock_gettime(CLOCK_MONOTONIC, &now) == 0);
  return static_cast<uint64_t>(now.tv_sec) * UINT64_C(1000000000) + now.tv_nsec;
}

struct HistogramDeleter {
  void operator()(hdr_histogram* histogram) const { hdr_close(histogram); }
};

// Match the upstream read/write locking and lock ordering. The mutex is
// mutable because a read lock protects logically const histogram queries.
class RwLock {
 public:
  class ScopedReadLock {
   public:
    explicit ScopedReadLock(const RwLock& lock) : lock_(lock.mutex_) {}
   private:
    std::shared_lock<std::shared_mutex> lock_;
  };
  class ScopedWriteLock {
   public:
    explicit ScopedWriteLock(const RwLock& lock) : lock_(lock.mutex_) {}
   private:
    std::unique_lock<std::shared_mutex> lock_;
  };
 private:
  mutable std::shared_mutex mutex_;
};
}  // namespace kandelo::histogram
#endif
