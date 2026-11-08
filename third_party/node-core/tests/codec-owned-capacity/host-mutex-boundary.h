// Native component boundary only. Real std mutex and release-fatal asserts;
// no claim that SpiderMonkey's mutex/JSAPI/TU was compiled or executed.
#ifndef KANDELO_CODEC_CAPACITY_HOST_BOUNDARY_H
#define KANDELO_CODEC_CAPACITY_HOST_BOUNDARY_H
#include <cstdlib>
#include <mutex>
#define MOZ_RELEASE_ASSERT(condition, ...) do { if (!(condition)) std::abort(); } while (0)
#define MOZ_CRASH(...) std::abort()
namespace js {
namespace mutexid { constexpr int ShellOffThreadState = 0; }
class Mutex {
  std::mutex mutex_;
 public:
  explicit Mutex(int) {}
  void lock() { mutex_.lock(); }
  void unlock() { mutex_.unlock(); }
};
template<class T> using LockGuard = std::lock_guard<T>;
}
#endif
