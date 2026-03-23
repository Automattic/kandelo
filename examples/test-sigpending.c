#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>

int main(void) {
    sigset_t blockset, pendingset, checkset;

    sigemptyset(&blockset);
    sigaddset(&blockset, SIGUSR2);

    printf("Blocking SIGUSR2...\n");
    if (sigprocmask(SIG_SETMASK, &blockset, NULL) == -1) {
        printf("sigprocmask failed: %d\n", errno);
        return 1;
    }

    /* Check blocked mask */
    sigset_t curblocked;
    sigemptyset(&curblocked);
    sigprocmask(SIG_SETMASK, NULL, &curblocked);
    unsigned long *bits_b = (unsigned long *)&curblocked;
    printf("blocked mask: 0x%lx 0x%lx\n", bits_b[0], bits_b[1]);

    printf("Raising SIGUSR2 via kill(getpid(), SIGUSR2)...\n");
    if (kill(getpid(), SIGUSR2) != 0) {
        printf("kill failed: %d\n", errno);
        return 1;
    }

    printf("Calling sigpending...\n");
    sigemptyset(&pendingset);
    int ret = sigpending(&pendingset);
    printf("sigpending returned %d (errno=%d)\n", ret, errno);

    if (ret == 0) {
        int is_member = sigismember(&pendingset, SIGUSR2);
        printf("SIGUSR2 pending: %d\n", is_member);

        /* Print raw bits for debugging */
        unsigned long *bits = (unsigned long *)&pendingset;
        printf("pendingset: 0x%lx 0x%lx\n", bits[0], bits[1]);
    }

    if (ret == 0 && sigismember(&pendingset, SIGUSR2) == 1) {
        printf("PASS\n");
        return 0;
    } else {
        printf("FAIL\n");
        return 1;
    }
}
