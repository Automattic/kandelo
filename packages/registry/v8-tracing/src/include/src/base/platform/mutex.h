#pragma once
#include <mutex>
#include "src/base/logging.h"
namespace v8::base {
// Source-interface locks over the guest C++/pthread implementation. The same
// mutex can be atomically released/reacquired by the original job algorithm.
class Mutex {
  std::mutex mutex_;
 public:
  void Lock(){mutex_.lock();}
  void Unlock(){mutex_.unlock();}
  std::mutex& Native(){return mutex_;}
};
class MutexGuard:public std::unique_lock<std::mutex> {
 public:explicit MutexGuard(Mutex* mutex):std::unique_lock<std::mutex>(mutex->Native()){}
};
}
