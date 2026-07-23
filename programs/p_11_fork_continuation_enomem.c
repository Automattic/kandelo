// P-11 — a linked fork continuation that exhausts process address space must
// return ENOMEM without creating a child or poisoning a later fork.

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

#define WASM_PAGE_BYTES (64u * 1024u)
#define MAX_FILLER_MAPPINGS 512

static void *filler_mappings[MAX_FILLER_MAPPINGS];

__attribute__((noinline))
static pid_t fork_at_depth(int depth) {
    if (depth == 0) return fork();

    pid_t result = fork_at_depth(depth - 1);
    // WHY: keep each recursive activation live across fork so instrumentation
    // must save enough frames to request a second continuation chunk.
    __asm__ volatile("" : "+r"(depth));
    return result + (depth == -1);
}

static int release_fillers(size_t count) {
    int failed = 0;
    for (size_t i = 0; i < count; i++) {
        if (munmap(filler_mappings[i], WASM_PAGE_BYTES) != 0) failed = 1;
    }
    return failed;
}

int main(void) {
    const pid_t original_pid = getpid();
    size_t filler_count = 0;

    while (filler_count < MAX_FILLER_MAPPINGS) {
        void *mapping = mmap(
            NULL,
            WASM_PAGE_BYTES,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
            -1,
            0
        );
        if (mapping == MAP_FAILED) break;
        filler_mappings[filler_count++] = mapping;
    }

    if (filler_count == MAX_FILLER_MAPPINGS || errno != ENOMEM) {
        printf(
            "FAIL: address-space fill count=%zu errno=%d\n",
            filler_count,
            errno
        );
        release_fillers(filler_count);
        return 1;
    }
    if (filler_count == 0) {
        printf("FAIL: no filler mapping was available\n");
        return 1;
    }

    // WHY: one free page lets beginUnwind allocate its root chunk. The deep
    // call chain then needs another chunk, so failure occurs after frames have
    // been committed and exercises ABORT_UNWINDING rather than the simpler
    // root-allocation error path.
    filler_count--;
    if (munmap(filler_mappings[filler_count], WASM_PAGE_BYTES) != 0) {
        printf("FAIL: could not make one continuation page available errno=%d\n", errno);
        release_fillers(filler_count);
        return 1;
    }

    errno = 0;
    const pid_t failed_child = fork_at_depth(4096);
    const int fork_errno = errno;
    if (failed_child != -1 || fork_errno != ENOMEM) {
        printf(
            "FAIL: deep fork result=%d errno=%d\n",
            (int)failed_child,
            fork_errno
        );
        release_fillers(filler_count);
        return 1;
    }
    if (getpid() != original_pid) {
        printf("FAIL: process identity changed after failed fork\n");
        release_fillers(filler_count);
        return 1;
    }
    printf("CONTINUATION_ENOMEM: ok\n");

    int status = 0;
    errno = 0;
    const pid_t phantom = waitpid(-1, &status, WNOHANG);
    if (phantom != -1 || errno != ECHILD) {
        printf("FAIL: failed fork left child=%d errno=%d\n", (int)phantom, errno);
        release_fillers(filler_count);
        return 1;
    }
    printf("NO_PHANTOM_CHILD: ok\n");

    // The abort replay must unmap its partial chain. Prove that the one free
    // page is reusable before relying on it for the recovery fork.
    void *probe = mmap(
        NULL,
        WASM_PAGE_BYTES,
        PROT_READ | PROT_WRITE,
        MAP_PRIVATE | MAP_ANONYMOUS,
        -1,
        0
    );
    if (probe == MAP_FAILED) {
        printf("FAIL: continuation allocation leaked errno=%d\n", errno);
        release_fillers(filler_count);
        return 1;
    }
    if (munmap(probe, WASM_PAGE_BYTES) != 0) {
        printf("FAIL: probe cleanup errno=%d\n", errno);
        release_fillers(filler_count);
        return 1;
    }
    printf("CONTINUATION_PAGE_REUSED: ok\n");

    const pid_t recovery_child = fork();
    if (recovery_child < 0) {
        printf("FAIL: recovery fork errno=%d\n", errno);
        release_fillers(filler_count);
        return 1;
    }
    if (recovery_child == 0) {
        if (getppid() != original_pid) _exit(2);
        printf("RECOVERY_CHILD: ok\n");
        fflush(stdout);
        _exit(0);
    }
    if (waitpid(recovery_child, &status, 0) != recovery_child) {
        printf("FAIL: recovery waitpid errno=%d\n", errno);
        release_fillers(filler_count);
        return 1;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        printf("FAIL: recovery child status=%d\n", status);
        release_fillers(filler_count);
        return 1;
    }
    if (getpid() != original_pid) {
        printf("FAIL: parent identity changed after recovery fork\n");
        release_fillers(filler_count);
        return 1;
    }
    printf("RECOVERY_PARENT: child=%d\n", (int)recovery_child);

    if (release_fillers(filler_count)) {
        printf("FAIL: filler cleanup errno=%d\n", errno);
        return 1;
    }
    printf("PASS: P-11\n");
    return 0;
}
