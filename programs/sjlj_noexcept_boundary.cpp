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

// LLVM 21 lowers noexcept to a catch-all termination region. With Wasm SjLj,
// that region intercepts the internal longjmp exception before the enclosing
// sigsetjmp landing can consume it. See issue #918.
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

#ifndef KANDELO_SJLJ_NO_FORK_ANCHOR
// The test never selects this branch. Its kernel_fork import makes the wasm32
// program a real input to fork-instrument, so the saved raw module and normal
// program exercise distinct pre- and post-instrumentation artifacts.
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
#endif

int main(int argc, char **argv)
{
#ifndef KANDELO_SJLJ_NO_FORK_ANCHOR
    if (argc == 2 && std::strcmp(argv[1], "--fork-instrumentation-anchor") == 0) {
        return fork_instrumentation_anchor();
    }
#endif

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
