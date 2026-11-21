#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>
#define CHECK(e) do { if (!(e)) { fprintf(stderr,"FAIL line=%d errno=%d: %s\n",__LINE__,errno,#e); _Exit(1); } } while(0)
static unsigned int counter;
int main(void) {
    int blocked[2], ready[2]; char token;
    CHECK(pipe(blocked) == 0 && pipe(ready) == 0);
    pid_t child = fork(); CHECK(child >= 0);
    if (child == 0) {
        CHECK(close(blocked[1]) == 0 && close(ready[0]) == 0);
        CHECK(write(ready[1], "r", 1) == 1 && close(ready[1]) == 0);
        CHECK(read(blocked[0], &token, 1) == 1);
        _Exit(99);
    }
    CHECK(close(ready[1]) == 0 && close(blocked[0]) == 0);
    CHECK(read(ready[0], &token, 1) == 1 && close(ready[0]) == 0);
    printf("blocked-ready pid=%d fd=%d\n", child, blocked[0]); fflush(stdout);
    /* Host sends k only after observing this exact registered read wait. */
    CHECK(read(0, &token, 1) == 1 && token == 'k');
    CHECK(kill(child, SIGKILL) == 0);
    int status; CHECK(waitpid(child, &status, 0) == child);
    CHECK(WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL);
    CHECK(close(blocked[1]) == 0); puts("wait-blocked PASS"); fflush(stdout);
    CHECK(pipe(ready) == 0); child = fork(); CHECK(child >= 0);
    if (child == 0) {
        CHECK(close(ready[0]) == 0 && write(ready[1], "r", 1) == 1 && close(ready[1]) == 0);
        for (;;) __atomic_fetch_add(&counter, 1, __ATOMIC_RELAXED);
    }
    CHECK(close(ready[1]) == 0 && read(ready[0], &token, 1) == 1 && close(ready[0]) == 0);
    printf("busy-ready pid=%d address=%lu\n", child, (unsigned long)(uintptr_t)&counter); fflush(stdout);
    /* Host must observe the child counter advance before sending k. */
    CHECK(read(0, &token, 1) == 1 && token == 'k');
    CHECK(kill(child, SIGKILL) == 0 && waitpid(child, &status, 0) == child);
    CHECK(WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL);
    CHECK(counter == 0); puts("wait-busy PASS");
    child = fork(); CHECK(child >= 0);
    if (child == 0) __builtin_trap();
    CHECK(waitpid(child, &status, 0) == child);
    CHECK(WIFSIGNALED(status) && WTERMSIG(status) == SIGSEGV);
    puts("wait-crash PASS"); puts("grouped-sdk-forced-exit PASS"); return 0;
}
