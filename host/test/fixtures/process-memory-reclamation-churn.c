#include <errno.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static const char *const child_path =
    "/bin/process-memory-reclamation-churn";

static long parse_positive(const char *text, long maximum) {
    char *end = NULL;
    errno = 0;
    long value = strtol(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' ||
        value < 1 || value > maximum) {
        return -1;
    }
    return value;
}

static int touch_memory(long mib) {
    const size_t bytes = (size_t)mib * 1024u * 1024u;
    volatile unsigned char *memory = malloc(bytes);
    if (memory == NULL) {
        fprintf(stderr, "child malloc(%zu) failed\n", bytes);
        return 10;
    }

    // WHY: growing a Wasm Memory is not enough to make its pages resident.
    // Touch one byte in every host page so process RSS measures the backing
    // store retained by a stale syscall-channel listener.
    uint32_t checksum = 0;
    for (size_t offset = 0; offset < bytes; offset += 4096u) {
        unsigned char value = (unsigned char)((offset >> 12) | 1u);
        memory[offset] = value;
        checksum += memory[offset];
    }
    memory[bytes - 1] = (unsigned char)(checksum | 1u);
    checksum += memory[bytes - 1];
    free((void *)memory);
    return checksum == 0 ? 11 : 0;
}

static int hold_memory(long mib) {
    const size_t bytes = (size_t)mib * 1024u * 1024u;
    volatile unsigned char *memory = malloc(bytes);
    if (memory == NULL) {
        fprintf(stderr, "control malloc(%zu) failed\n", bytes);
        return 12;
    }

    uint32_t checksum = 0;
    for (size_t offset = 0; offset < bytes; offset += 4096u) {
        unsigned char value = (unsigned char)((offset >> 12) | 1u);
        memory[offset] = value;
        checksum += memory[offset];
    }
    memory[bytes - 1] = (unsigned char)(checksum | 1u);
    checksum += memory[bytes - 1];
    if (checksum == 0) {
        return 13;
    }

    /*
     * WHY: scheduled RSS telemetry needs a positive control measured by the
     * same Kandelo process path. Keeping a real process and its touched
     * address space live proves that the engine-local sampler can distinguish
     * retained memory before it judges retired-memory behavior.
     */
    printf("PROCESS_MEMORY_CONTROL_READY\n");
    fflush(stdout);
    for (;;) {
        pause();
    }
}

static int run_parent(long count, long child_mib) {
    char mib_text[32];
    snprintf(mib_text, sizeof(mib_text), "%ld", child_mib);

    for (long iteration = 0; iteration < count; iteration++) {
        char *const child_argv[] = {
            (char *)child_path,
            (char *)"child",
            mib_text,
            NULL,
        };
        pid_t child = -1;
        int spawn_error = posix_spawn(
            &child,
            child_path,
            NULL,
            NULL,
            child_argv,
            environ
        );
        if (spawn_error != 0) {
            fprintf(
                stderr,
                "posix_spawn iteration %ld failed: %s\n",
                iteration,
                strerror(spawn_error)
            );
            return 20;
        }

        int status = 0;
        if (waitpid(child, &status, 0) != child) {
            fprintf(
                stderr,
                "waitpid iteration %ld failed: %s\n",
                iteration,
                strerror(errno)
            );
            return 21;
        }
        if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
            fprintf(
                stderr,
                "child iteration %ld returned status %d\n",
                iteration,
                status
            );
            return 22;
        }
    }

    printf(
        "PROCESS_MEMORY_RECLAMATION_PASS count=%ld child_mib=%ld\n",
        count,
        child_mib
    );
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 3 && strcmp(argv[1], "child") == 0) {
        long child_mib = parse_positive(argv[2], 64);
        if (child_mib < 0) {
            fprintf(stderr, "invalid child MiB: %s\n", argv[2]);
            return 2;
        }
        return touch_memory(child_mib);
    }
    if (argc == 3 && strcmp(argv[1], "hold") == 0) {
        long child_mib = parse_positive(argv[2], 64);
        if (child_mib < 0) {
            fprintf(stderr, "invalid control MiB: %s\n", argv[2]);
            return 2;
        }
        return hold_memory(child_mib);
    }
    if (argc != 3) {
        fprintf(stderr, "usage: %s <count> <child-mib>\n", argv[0]);
        return 3;
    }

    long count = parse_positive(argv[1], 4096);
    long child_mib = parse_positive(argv[2], 64);
    if (count < 0 || child_mib < 0) {
        fprintf(stderr, "invalid churn arguments\n");
        return 4;
    }
    return run_parent(count, child_mib);
}
