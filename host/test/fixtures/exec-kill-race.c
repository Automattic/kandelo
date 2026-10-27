/* Rust's std::process::Command on Kandelo: fork() from a non-main thread of
 * a multi-threaded process, exec in the child, then SIGKILL the child at a
 * chosen delay (tokio's kill_on_drop). The kill can land after the kernel
 * commits the exec and before the host installs the new image, and the
 * parent's waitpid() can reap the child in that window too.
 * POSIX: waitpid reports SIGKILL or a normal exit; the parent and every
 * other process are unaffected. Prints EXEC_KILL_RACE_OK after all rounds. */
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int rounds;
static long delay_us;
static volatile int done;

static void nap_us(long us) {
    struct timespec ts = {us / 1000000, (us % 1000000) * 1000};
    nanosleep(&ts, NULL);
}

static void *busy(void *arg) {
    (void)arg;
    while (!done) { nap_us(30); getpid(); }
    return NULL;
}

static void *spawner(void *arg) {
    (void)arg;
    for (int i = 0; i < rounds; i++) {
        pid_t pid = fork();
        if (pid == 0) {
            execl("/bin/sh", "sh", "-c", "sleep 5", (char *)NULL);
            _exit(127);
        }
        if (pid < 0) { perror("fork"); exit(2); }
        if (delay_us) nap_us(delay_us);
        kill(pid, SIGKILL);
        int status;
        if (waitpid(pid, &status, 0) != pid) exit(3);
        if (!(WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL) && !WIFEXITED(status)) exit(4);
    }
    printf("EXEC_KILL_RACE_OK rounds=%d\n", rounds);
    done = 1;
    return NULL;
}

int main(int argc, char **argv) {
    rounds = argc > 1 ? atoi(argv[1]) : 10;
    delay_us = argc > 2 ? atol(argv[2]) : 0;
    pthread_t b1, b2, s;
    pthread_create(&b1, NULL, busy, NULL);
    pthread_create(&b2, NULL, busy, NULL);
    pthread_create(&s, NULL, spawner, NULL);
    pthread_join(s, NULL);
    pthread_join(b1, NULL);
    pthread_join(b2, NULL);
    return 0;
}
