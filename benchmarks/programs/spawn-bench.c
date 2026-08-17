/* spawn-bench.c — measure posix_spawn + child exit latency.
 *
 * posix_spawn's a child running /bin/hello, waits for it, prints the
 * elapsed wall-clock as `spawn_ms`. The TypeScript suite wrapper picks
 * up that line. Mirrors `fork-bench.c` (which times fork()) and
 * `exec-bench.c` (which times execve()) — `spawn_ms` exists to catch
 * the spawn fast-path's contribution that those don't measure.
 *
 * Loaded via execPrograms-mapped /bin/hello (the same binary
 * exec-bench targets). The harness sets execPrograms[/bin/hello] to
 * the hello.wasm path; in the spawn child posix_spawn resolves
 * /bin/hello via the host's onSpawn callback and runs it directly —
 * no fork+exec replay.
 */
#include <spawn.h>
#include <stdio.h>
#include <sys/time.h>
#include <sys/wait.h>

extern char **environ;

static long long now_us(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000000LL + tv.tv_usec;
}

int main(void) {
    long long t0 = now_us();

    char *argv[] = { "hello", NULL };
    pid_t pid;
    int rc = posix_spawn(&pid, "/bin/hello", NULL, NULL, argv, environ);
    if (rc != 0) {
        fprintf(stderr, "posix_spawn: %d\n", rc);
        return 1;
    }

    int status;
    if (waitpid(pid, &status, 0) < 0) {
        perror("waitpid");
        return 2;
    }

    long long t1 = now_us();
    double ms = (t1 - t0) / 1000.0;
    printf("spawn_ms=%f\n", ms);
    return 0;
}
