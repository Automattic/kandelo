/* spawn-bench.c — measure posix_spawn + child exit latency.
 *
 * Measures an ordinary spawn, the first approximately 84 KiB Homebrew-like
 * environment transfer, and repeated transfers at that high-water mark.
 * The TypeScript suite wrapper picks up the printed metrics. Mirrors
 * `fork-bench.c` (which times fork()) and `exec-bench.c` (which times
 * execve()) — these metrics exist to catch the spawn fast-path's contribution
 * that those don't measure. The ordinary environment is fixed rather than
 * inherited from the benchmark runner, and a sample is valid only when the
 * waited child exits normally with status zero.
 *
 * Loaded via execPrograms-mapped /bin/hello (the same binary
 * exec-bench targets). The harness sets execPrograms[/bin/hello] to
 * the hello.wasm path; in the spawn child posix_spawn resolves
 * /bin/hello via the host's onSpawn callback and runs it directly —
 * no fork+exec replay.
 */
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <sys/wait.h>

#include "../../libc/musl-overlay/src/process/wasm32posix/spawn_contract.h"

static long long now_us(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000000LL + tv.tv_usec;
}

static int spawn_and_wait(char *const envp[], long long *elapsed_us) {
    long long t0 = now_us();

    char *argv[] = { "hello", NULL };
    pid_t pid;
    int rc = posix_spawn(&pid, "/bin/hello", NULL, NULL, argv, envp);
    if (rc != 0) {
        fprintf(stderr, "posix_spawn: %d\n", rc);
        return rc;
    }

    int status;
    pid_t waited = waitpid(pid, &status, 0);
    if (waited < 0) {
        perror("waitpid");
        return -1;
    }
    if (waited != pid) {
        fprintf(stderr, "waitpid returned unexpected child %d\n", (int)waited);
        return -1;
    }
    if (!WIFEXITED(status)) {
        if (WIFSIGNALED(status)) {
            fprintf(
                stderr,
                "spawn child terminated by signal %d\n",
                WTERMSIG(status)
            );
        } else {
            fprintf(stderr, "spawn child did not exit normally: status=%d\n", status);
        }
        return -1;
    }
    if (WEXITSTATUS(status) != 0) {
        fprintf(stderr, "spawn child exited with status %d\n", WEXITSTATUS(status));
        return -1;
    }

    *elapsed_us = now_us() - t0;
    return 0;
}

enum {
    LARGE_ENV_COUNT = 84,
    LARGE_ENV_ENTRY_BYTES = 1000,
    LARGE_REPEAT_COUNT = 5,
    LARGE_ARG_COUNT = 1,
    LARGE_ARG_STRING_BYTES = sizeof("hello"),
    LARGE_WIRE_BYTES =
        WASM_POSIX_SPAWN_HEADER_BYTES
        + WASM_POSIX_SPAWN_STRING_OFFSET_BYTES
            * (LARGE_ARG_COUNT + LARGE_ENV_COUNT)
        + LARGE_ARG_STRING_BYTES
        + LARGE_ENV_COUNT * LARGE_ENV_ENTRY_BYTES,
};

static char ordinary_lang[] = "LANG=C";
static char ordinary_path[] = "PATH=/bin";
static char *const ordinary_envp[] = {
    ordinary_lang,
    ordinary_path,
    NULL,
};

static char **make_large_environment(void) {
    char **envp = calloc(LARGE_ENV_COUNT + 1, sizeof(*envp));
    if (!envp) return NULL;

    for (size_t i = 0; i < LARGE_ENV_COUNT; i++) {
        envp[i] = malloc(LARGE_ENV_ENTRY_BYTES);
        if (!envp[i]) {
            while (i > 0) free(envp[--i]);
            free(envp);
            return NULL;
        }
        int prefix = snprintf(
            envp[i],
            LARGE_ENV_ENTRY_BYTES,
            "K%03zu=",
            i
        );
        if (prefix < 0 || prefix >= LARGE_ENV_ENTRY_BYTES) {
            for (size_t j = 0; j <= i; j++) free(envp[j]);
            free(envp);
            return NULL;
        }
        memset(
            envp[i] + prefix,
            'x',
            LARGE_ENV_ENTRY_BYTES - (size_t)prefix - 1
        );
        envp[i][LARGE_ENV_ENTRY_BYTES - 1] = '\0';
    }
    return envp;
}

static void free_large_environment(char **envp) {
    if (!envp) return;
    for (size_t i = 0; i < LARGE_ENV_COUNT; i++) free(envp[i]);
    free(envp);
}

int main(void) {
    long long ordinary_us;
    if (spawn_and_wait(ordinary_envp, &ordinary_us) != 0) return 1;
    printf("spawn_ms=%f\n", ordinary_us / 1000.0);

    char **large_envp = make_large_environment();
    if (!large_envp) {
        perror("large spawn environment");
        return 2;
    }
    printf("spawn_large_wire_bytes=%u\n", (unsigned)LARGE_WIRE_BYTES);

    long long first_large_us;
    if (spawn_and_wait(large_envp, &first_large_us) != 0) {
        free_large_environment(large_envp);
        return 3;
    }
    printf("spawn_large_first_ms=%f\n", first_large_us / 1000.0);

    long long repeated_us = 0;
    for (int i = 0; i < LARGE_REPEAT_COUNT; i++) {
        long long sample_us;
        if (spawn_and_wait(large_envp, &sample_us) != 0) {
            free_large_environment(large_envp);
            return 4;
        }
        repeated_us += sample_us;
    }
    printf(
        "spawn_large_repeat_ms=%f\n",
        repeated_us / (1000.0 * LARGE_REPEAT_COUNT)
    );

    free_large_environment(large_envp);
    return 0;
}
