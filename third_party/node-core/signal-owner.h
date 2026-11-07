// Genuine process signal capture. Handler work is limited to native
// bookkeeping and an async-signal-safe nonblocking pipe write. JS runs only
// after the owning loop dequeues the actual record.
#ifndef KANDELO_NODE_SIGNAL_OWNER_H_
#define KANDELO_NODE_SIGNAL_OWNER_H_
#include <atomic>
#include <cassert>
#include <cstdlib>
#include <cerrno>
#include <cstdint>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <unistd.h>

namespace kandelo::signals {
class Loop;
struct Watch;
struct Message { uint64_t cookie; int32_t signum; uint32_t padding; };
static_assert(sizeof(Message) <= 512, "Signal records fit POSIX atomic pipe writes");
// Ordinary mutations block caught signals on that thread before entering the
// atomic gate. A handler therefore cannot interrupt its own lock holder.
// All critical sections are native-only: no allocation, JS or user callbacks.
constinit inline std::atomic_flag gate = ATOMIC_FLAG_INIT;
inline Watch* heads[NSIG] = {};
inline uint64_t nextCookie = 0; // primary loop thread only
inline void Lock() noexcept { while (gate.test_and_set(std::memory_order_acquire)) {} }
inline void Unlock() noexcept { gate.clear(std::memory_order_release); }
class MaskLock {
  sigset_t saved_{};
  int error_ = 0;
 public:
  MaskLock() noexcept {
    sigset_t all;
    if (sigfillset(&all) != 0) { error_ = errno; return; }
    error_ = ::pthread_sigmask(SIG_SETMASK, &all, &saved_);
    if (!error_) Lock();
  }
  ~MaskLock() {
    if (error_) return;
    Unlock();
    if (::pthread_sigmask(SIG_SETMASK, &saved_, nullptr) != 0) ::abort();
  }
  MaskLock(const MaskLock&) = delete;
  int Error() const noexcept { return error_; }
};
struct Watch {
  Loop* loop;
  Watch* nextSignal = nullptr;
  Watch* nextLoop = nullptr;
  const uint64_t cookie;
  int signum = 0;
  uint64_t caught = 0, dispatched = 0; // gate protected
  bool referenced = true, closing = false, closed = false;
  explicit Watch(Loop& owner);
  ~Watch();
  Watch(const Watch&) = delete;
  int Start(int signal) noexcept;
  int Stop() noexcept;
  int Close() noexcept { if (closing || closed) return 0; const int error = Stop(); if (!error) closing = true; return error; }
  bool ReadyToClose() noexcept { MaskLock lock; if (lock.Error()) ::abort(); return closing && caught == dispatched; }
  bool HasPending() noexcept { MaskLock lock; if (lock.Error()) ::abort(); return caught != dispatched; }
  void RetireMessage() noexcept { MaskLock lock; if (lock.Error()) ::abort(); ++dispatched; }
};
class Loop {
  friend struct Watch;
  friend void Handler(int) noexcept;
  int pipe_[2] = {-1, -1};
  Watch* watches_ = nullptr;
 public:
  Loop() = default;
  Loop(const Loop&) = delete;
  int Initialize() noexcept {
    if (pipe_[0] >= 0) return 0;
    int descriptors[2];
    if (::pipe(descriptors) < 0) return errno;
    for (int fd : descriptors) {
      const int flags = ::fcntl(fd, F_GETFL, 0);
      if (flags < 0 || ::fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0 ||
          ::fcntl(fd, F_SETFD, FD_CLOEXEC) < 0) {
        const int error = errno; ::close(descriptors[0]); ::close(descriptors[1]); return error;
      }
    }
    pipe_[0] = descriptors[0]; pipe_[1] = descriptors[1]; return 0;
  }
  ~Loop() {
    // Real watch owners unregister before the loop/pipe can disappear.
    assert(!watches_);
    if (pipe_[0] >= 0) ::close(pipe_[0]);
    if (pipe_[1] >= 0) ::close(pipe_[1]);
  }
  int Read(Message* message) noexcept {
    ssize_t size;
    do { size = ::read(pipe_[0], message, sizeof(*message)); } while (size < 0 && errno == EINTR);
    if (size < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
    if (size == ssize_t(sizeof(*message))) return 1;
    return -(size < 0 ? errno : EIO);
  }
  Watch* Find(uint64_t cookie) const noexcept {
    for (auto* watch = watches_; watch; watch = watch->nextLoop)
      if (watch->cookie == cookie) return watch;
    return nullptr;
  }
  bool HasReferences() const noexcept {
    for (auto* watch = watches_; watch; watch = watch->nextLoop)
      if (watch->closing || (watch->signum && watch->referenced)) return true;
    return false;
  }
  Watch* ReadyClose() const noexcept {
    for (auto* watch = watches_; watch; watch = watch->nextLoop)
      if (watch->ReadyToClose()) return watch;
    return nullptr;
  }
};
inline void Handler(int signum) noexcept {
  const int saved = errno;
  Lock();
  for (auto* watch = heads[signum]; watch; watch = watch->nextSignal) {
    Message message{watch->cookie, signum, 0};
    ssize_t written;
    do { written = ::write(watch->loop->pipe_[1], &message, sizeof(message)); }
    while (written < 0 && errno == EINTR);
    // The same explicit pipe-full limitation exists in the pinned uv handler.
    // A failed write never increments caught or manufactures a queued event.
    if (written == ssize_t(sizeof(message))) ++watch->caught;
    else if (written >= 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) ::abort();
  }
  Unlock(); errno = saved;
}
inline Watch::Watch(Loop& owner) : loop(&owner), cookie(++nextCookie) {
  assert(cookie); nextLoop = loop->watches_; loop->watches_ = this;
}
inline Watch::~Watch() {
  if (Stop() != 0) ::abort();
  auto** link = &loop->watches_;
  while (*link && *link != this) link = &(*link)->nextLoop;
  assert(*link == this); *link = nextLoop;
}
inline int Watch::Start(int signal) noexcept {
  if (closing || closed || signal <= 0 || signal >= NSIG) return EINVAL;
  if (signum == signal) return 0;
  if (signum) { const int error = Stop(); if (error) return error; }
  MaskLock lock; if (lock.Error()) return lock.Error();
  struct sigaction previous{};
  if (::sigaction(signal, nullptr, &previous) < 0) return errno;
  if (heads[signal]) {
    // Another native owner may have replaced our disposition; do not report
    // an active subscription when our C handler no longer owns delivery.
    if ((previous.sa_flags & SA_SIGINFO) || previous.sa_handler != Handler) return EBUSY;
  } else {
    // Preserve existing engine/coverage/interrupt handlers. Safe multiplexing
    // is an explicit remaining implementation gap, never silent replacement.
    if (previous.sa_handler != SIG_DFL && previous.sa_handler != SIG_IGN) return EBUSY;
    struct sigaction action{};
    action.sa_handler = Handler; action.sa_flags = SA_RESTART;
    if (sigfillset(&action.sa_mask) != 0) return errno;
    if (::sigaction(signal, &action, nullptr) < 0) return errno;
  }
  signum = signal; nextSignal = heads[signal]; heads[signal] = this; return 0;
}
inline int Watch::Stop() noexcept {
  if (!signum) return 0;
  MaskLock lock; if (lock.Error()) return lock.Error();
  auto** link = &heads[signum];
  while (*link && *link != this) link = &(*link)->nextSignal;
  assert(*link == this);
  if (heads[signum] == this && !nextSignal) {
    struct sigaction current{};
    if (::sigaction(signum, nullptr, &current) < 0) return errno;
    if (!(current.sa_flags & SA_SIGINFO) && current.sa_handler == Handler) {
      struct sigaction action{}; action.sa_handler = SIG_DFL;
      if (sigemptyset(&action.sa_mask) != 0) return errno;
      if (::sigaction(signum, &action, nullptr) < 0) return errno;
    }
  }
  *link = nextSignal; nextSignal = nullptr; signum = 0; return 0;
}
} // namespace kandelo::signals
#endif
