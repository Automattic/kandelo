// An exact-pid POSIX wait owner. A reaped result remains owned until its sink
// succeeds; JS allocation failure must not turn the next wait into ECHILD/0.
#ifndef KANDELO_NODE_CHILD_WAIT_H
#define KANDELO_NODE_CHILD_WAIT_H
#include <cerrno>
#include <sys/types.h>
#include <sys/wait.h>
namespace kandelo::child_wait {
enum class Kind { Pending, Exit, Signal, Error };
struct Outcome {
  Kind kind = Kind::Pending;
  int code = 0, signal = 0, error = 0;
};
struct PosixWait {
  pid_t Wait(pid_t pid, int* status) { return ::waitpid(pid, status, WNOHANG); }
  int Error() const { return errno; }
};
class State {
  pid_t pid_;
  Outcome outcome_;
  bool delivered_ = false;
 public:
  explicit State(pid_t pid = -1) : pid_(pid) {}
  pid_t Pid() const { return pid_; }
  bool Ready() const { return outcome_.kind != Kind::Pending; }
  const Outcome& Result() const { return outcome_; }
  template <typename Backend> void Poll(Backend& backend) {
    if (Ready() || delivered_) return;
    if (pid_ <= 0) { outcome_ = {Kind::Error, 0, 0, EINVAL}; return; }
    int status = 0, error = 0; pid_t result;
    do { result = backend.Wait(pid_, &status); error = result < 0 ? backend.Error() : 0; }
    while (result < 0 && error == EINTR);
    if (result == 0) return;
    if (result < 0) { outcome_ = {Kind::Error, 0, 0, error ? error : EIO}; return; }
    if (result != pid_) { outcome_ = {Kind::Error, 0, 0, EIO}; return; }
    if (WIFEXITED(status)) outcome_ = {Kind::Exit, WEXITSTATUS(status), 0, 0};
    else if (WIFSIGNALED(status)) outcome_ = {Kind::Signal, 0, WTERMSIG(status), 0};
    // A stopped/continued notification is not successful process termination.
  }
  void Poll() { PosixWait backend; Poll(backend); }
  template <typename Sink> bool Deliver(Sink&& sink) {
    if (delivered_) return true;
    if (!Ready() || !sink(outcome_)) return false;
    delivered_ = true; return true;
  }
};
}  // namespace kandelo::child_wait
#endif
