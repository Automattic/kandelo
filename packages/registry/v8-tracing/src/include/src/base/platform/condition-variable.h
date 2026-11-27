#pragma once
#include <condition_variable>
#include "src/base/platform/mutex.h"
namespace v8::base {
class ConditionVariable {
  std::condition_variable condition_;
 public:
  void Wait(Mutex* mutex){
    std::unique_lock<std::mutex> lock(mutex->Native(),std::adopt_lock);
    condition_.wait(lock);
    // The caller's original MutexGuard still owns this lock on return.
    lock.release();
  }
  void NotifyOne(){condition_.notify_one();}
  void NotifyAll(){condition_.notify_all();}
};
}
