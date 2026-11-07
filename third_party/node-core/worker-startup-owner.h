#ifndef KANDELO_NODE_WORKER_STARTUP_OWNER_H
#define KANDELO_NODE_WORKER_STARTUP_OWNER_H
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <type_traits>
#include <utility>
namespace kandelo::worker {
// Owns both real startup packet slots and their independent read leases. A
// dropped LOAD publishes no input. Real metadata may prepare the environment;
// its presence never substitutes for a missing LOAD or fabricated argv.
template<class Packet> class StartupGate {
  static_assert(std::is_nothrow_move_assignable_v<Packet>);
  std::mutex mutex_;
  std::condition_variable ready_;
  Packet bootstrap_, input_;
  bool published_ = false, bootstrapRead_ = false, inputRead_ = false, stopped_ = false;
 public:
  enum class Read { Ready, Repeated, Stopped, Interrupted };
  bool Publish(Packet bootstrap, Packet input) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (published_ || stopped_) return false;
    bootstrap_ = std::move(bootstrap); input_ = std::move(input);
    published_ = true; ready_.notify_all(); return true;
  }
  template<class Interrupt>
  Read Take(bool bootstrap, Packet* result, Interrupt&& interrupt) {
    std::unique_lock<std::mutex> lock(mutex_);
    bool& read = bootstrap ? bootstrapRead_ : inputRead_;
    if (read) return Read::Repeated;
    read = true;
    Packet& slot = bootstrap ? bootstrap_ : input_;
    while (!stopped_ && !slot) {
      ready_.wait_for(lock, std::chrono::milliseconds(10));
      // GC/general interrupts can reenter the actual Stop owner. No gate
      // mutex or packet pointer may be borrowed over that checkpoint.
      lock.unlock();
      if (!interrupt()) return Read::Interrupted;
      lock.lock();
    }
    if (stopped_) return Read::Stopped;
    *result = std::move(slot); return Read::Ready;
  }
  void Stop() {
    { std::lock_guard<std::mutex> lock(mutex_); stopped_ = true; }
    ready_.notify_all();
  }
  template<class Retire>
  void Clear(Retire&& retire) {
    Packet bootstrap, input;
    { std::lock_guard<std::mutex> lock(mutex_);
      stopped_ = true;
      bootstrap = std::move(bootstrap_); input = std::move(input_); }
    ready_.notify_all();
    // Packet/endpoint graph retirement can reenter Stop or acquire other
    // owning locks. Native locals retain both slots after releasing this lock.
    retire(bootstrap); retire(input);
  }
};
}  // namespace kandelo::worker
#endif
