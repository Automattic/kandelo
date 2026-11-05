#include "third_party/node-core/child-wait.h"
#include <cassert>
#include <cstdio>
#include <signal.h>
#include <unistd.h>
using namespace kandelo::child_wait;
static pid_t children[3]{};
static unsigned childCount = 0;
static void Cleanup(int signal) {
  for (unsigned i = 0; i < childCount; i++) {
    int status; pid_t result;
    do { result = waitpid(children[i], &status, WNOHANG); } while (result < 0 && errno == EINTR);
    // A reaped pid may have been reused. Only signal our still-waitable child.
    if (result == 0) {
      kill(children[i], SIGKILL);
      while (waitpid(children[i], &status, 0) < 0 && errno == EINTR) {}
    }
  }
  _exit(128 + signal);
}
struct CountingWait : PosixWait {
  int calls = 0;
  pid_t Wait(pid_t pid, int* status) { ++calls; return PosixWait::Wait(pid, status); }
};
static pid_t Child(int* gate) {
  int pipefd[2]; assert(pipe(pipefd) == 0);
  const pid_t pid = fork(); assert(pid >= 0);
  if (pid == 0) { close(pipefd[1]); char byte; while (read(pipefd[0], &byte, 1) < 0 && errno == EINTR) {} _exit(37); }
  assert(childCount < 3); children[childCount++] = pid;
  close(pipefd[0]); *gate = pipefd[1]; return pid;
}
static void Peek(pid_t pid, int options) {
  siginfo_t info{}; int result;
  do { result = waitid(P_PID, id_t(pid), &info, options | WNOWAIT); } while (result < 0 && errno == EINTR);
  assert(result == 0 && info.si_pid == pid);
}
int main() {
  signal(SIGABRT, Cleanup); signal(SIGALRM, Cleanup); alarm(10);
  int gate; const pid_t pid = Child(&gate); State state(pid); CountingWait backend;
  state.Poll(backend); assert(!state.Ready() && backend.calls == 1);
  char byte = 1; assert(write(gate, &byte, 1) == 1); close(gate); Peek(pid, WEXITED);
  state.Poll(backend); assert(state.Result().kind == Kind::Exit && state.Result().code == 37);
  const int calls = backend.calls; int deliveries = 0;
  assert(!state.Deliver([&](const Outcome& value) { ++deliveries; assert(value.code == 37); return false; }));
  state.Poll(backend); assert(backend.calls == calls);
  assert(state.Deliver([&](const Outcome& value) { ++deliveries; assert(value.code == 37); return true; }));
  assert(state.Deliver([&](const Outcome&) { ++deliveries; return true; })); assert(deliveries == 2);
  State missing(pid); missing.Poll(); assert(missing.Result().kind == Kind::Error && missing.Result().error == ECHILD);

  const pid_t signaled = Child(&gate); State signalState(signaled);
  assert(kill(signaled, SIGSTOP) == 0); Peek(signaled, WSTOPPED);
  signalState.Poll(); assert(!signalState.Ready());
  struct StoppedWait : PosixWait {
    pid_t Wait(pid_t pid, int* status) { return waitpid(pid, status, WNOHANG | WUNTRACED); }
  } stopped;
  signalState.Poll(stopped); assert(!signalState.Ready());
  assert(kill(signaled, SIGCONT) == 0); assert(kill(signaled, SIGTERM) == 0);
  Peek(signaled, WEXITED); close(gate); signalState.Poll();
  assert(signalState.Result().kind == Kind::Signal && signalState.Result().signal == SIGTERM);

  struct Interrupted : PosixWait {
    int calls = 0;
    pid_t Wait(pid_t pid, int* status) { if (++calls == 1) { errno = EINTR; return -1; } return PosixWait::Wait(pid, status); }
  } interrupted;
  const pid_t retry = Child(&gate); State retryState(retry); retryState.Poll(interrupted);
  assert(interrupted.calls == 2 && !retryState.Ready());
  close(gate); Peek(retry, WEXITED); retryState.Poll(); assert(retryState.Result().kind == Kind::Exit);
  State invalid(-1); CountingWait never; invalid.Poll(never);
  assert(never.calls == 0 && invalid.Result().kind == Kind::Error && invalid.Result().error == EINVAL);
  alarm(0);
  printf("{\"passed\":true,\"exitCode\":37,\"signal\":%d,\"missingErrno\":%d,\"retainedAfterSinkFailure\":true,\"stoppedIsPending\":true,\"interruptedRetryCalls\":2}\n", SIGTERM, ECHILD);
}
