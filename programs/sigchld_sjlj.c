#include <errno.h>
#include <setjmp.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <unistd.h>

static sigjmp_buf signal_landing;

static void sigchld_handler(int signo, siginfo_t *info, void *context)
{
    (void)info;
    (void)context;
    if (signo == SIGCHLD) {
        siglongjmp(signal_landing, 1);
    }
}

static int wait_for_sigchld(pid_t child, const sigset_t *original_mask)
{
    if (sigsetjmp(signal_landing, 1) == 0) {
        sigset_t wait_mask = *original_mask;
        sigdelset(&wait_mask, SIGCHLD);
        int result = pselect(0, NULL, NULL, NULL, NULL, &wait_mask);
        fprintf(stderr, "pselect returned without siglongjmp: %d (%s)\n",
                result, strerror(errno));
        return 1;
    }

    int status = 0;
    pid_t waited;
    do {
        waited = waitpid(child, &status, 0);
    } while (waited == -1 && errno == EINTR);

    if (sigprocmask(SIG_SETMASK, original_mask, NULL) != 0) {
        fprintf(stderr, "sigprocmask restore: %s\n", strerror(errno));
        return 1;
    }
    if (waited != child || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fputs("waitpid did not reap the expected clean child\n", stderr);
        return 1;
    }

    puts("PASS: SIGCHLD siglongjmp resumed at pselect landing pad");
    return 0;
}

int main(void)
{
    sigset_t blocked_mask;
    sigset_t original_mask;
    sigemptyset(&blocked_mask);
    sigaddset(&blocked_mask, SIGCHLD);
    if (sigprocmask(SIG_BLOCK, &blocked_mask, &original_mask) != 0) {
        fprintf(stderr, "sigprocmask block: %s\n", strerror(errno));
        return 1;
    }

    struct sigaction action = {0};
    action.sa_sigaction = sigchld_handler;
    action.sa_flags = SA_SIGINFO;
    sigfillset(&action.sa_mask);
    if (sigaction(SIGCHLD, &action, NULL) != 0) {
        fprintf(stderr, "sigaction: %s\n", strerror(errno));
        return 1;
    }

    pid_t child = fork();
    if (child == -1) {
        fprintf(stderr, "fork: %s\n", strerror(errno));
        return 1;
    }
    if (child == 0) {
        _exit(0);
    }

    return wait_for_sigchld(child, &original_mask);
}
