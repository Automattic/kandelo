#include <cerrno>
#include <cstdio>
#include <cstring>
#include <setjmp.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

static sigjmp_buf signal_landing;

static void signal_handler(int signo)
{
    static const char marker[] = "HANDLER: siglongjmp\n";
    if (signo == SIGUSR1) {
        (void)write(STDERR_FILENO, marker, sizeof(marker) - 1);
        siglongjmp(signal_landing, 1);
    }
}

// Clang lowers noexcept to a catch-all termination region. With Wasm SjLj,
// that region is nearer than main's generated longjmp landing and therefore
// consumes the signal handler's exception tag first.
__attribute__((noinline)) static void raise_from_noexcept() noexcept
{
    if (raise(SIGUSR1) != 0) {
        std::fprintf(stderr, "raise: %s\n", std::strerror(errno));
    }
}

__attribute__((noinline)) static void raise_from_permissive_boundary()
{
    if (raise(SIGUSR1) != 0) {
        std::fprintf(stderr, "raise: %s\n", std::strerror(errno));
    }
}

// This branch is never selected by the SjLj tests. Its kernel_fork import
// deliberately makes fork-instrument transform the normal fixture so the
// preserved raw output is a real pre-instrumentation control, not a second
// copy of a module on which the tool was a no-op.
__attribute__((noinline)) static int fork_instrumentation_anchor()
{
    pid_t child = fork();
    if (child == -1) {
        return 1;
    }
    if (child == 0) {
        _exit(0);
    }

    int status = 0;
    return waitpid(child, &status, 0) == child && WIFEXITED(status)
            && WEXITSTATUS(status) == 0
        ? 0
        : 1;
}

int main(int argc, char **argv)
{
    if (argc == 2 && std::strcmp(argv[1], "--fork-instrumentation-anchor") == 0) {
        return fork_instrumentation_anchor();
    }

    struct sigaction action = {};
    action.sa_handler = signal_handler;
    sigfillset(&action.sa_mask);
    if (sigaction(SIGUSR1, &action, nullptr) != 0) {
        std::fprintf(stderr, "sigaction: %s\n", std::strerror(errno));
        return 1;
    }

    if (sigsetjmp(signal_landing, 1) == 0) {
        if (argc == 2 && std::strcmp(argv[1], "--permissive") == 0) {
            raise_from_permissive_boundary();
        } else {
            raise_from_noexcept();
        }
        static const char unexpected[] = "FAIL: raise returned past signal handler\n";
        (void)write(STDERR_FILENO, unexpected, sizeof(unexpected) - 1);
        return 2;
    }

    static const char landed[] = "LANDING: siglongjmp resumed\n";
    (void)write(STDOUT_FILENO, landed, sizeof(landed) - 1);
    return 0;
}
