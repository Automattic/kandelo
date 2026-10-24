// P-11 — root and later linked-fork continuation allocations that exhaust
// process address space must return ENOMEM without creating a child or
// poisoning the still-running parent.

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

#define WASM_PAGE_BYTES (64u * 1024u)
#define MAX_FILLER_MAPPINGS 512

#ifndef P11_RECURSION_DEPTH
#define P11_RECURSION_DEPTH 4096
#endif

#ifdef P11_WIDE_FRAME
// A second shape reaches another continuation page with fewer native calls.
// Volatile reads must stay live across recursion; shadow-stack arrays would
// consume linear memory instead of widening the captured Wasm activation.
typedef unsigned __int128 carry_value_t;
static volatile carry_value_t carry_seeds[16] = {
    11, 23, 37, 41, 53, 67, 79, 83,
    97, 101, 113, 127, 137, 149, 157, 163,
};
#endif

static void *filler_mappings[MAX_FILLER_MAPPINGS];

__attribute__((noinline))
static pid_t fork_at_depth(int depth) {
    if (depth == 0) return fork();

#ifdef P11_WIDE_FRAME
    const carry_value_t a = carry_seeds[0], b = carry_seeds[1];
    const carry_value_t c = carry_seeds[2], d = carry_seeds[3];
    const carry_value_t e = carry_seeds[4], f = carry_seeds[5];
    const carry_value_t g = carry_seeds[6], h = carry_seeds[7];
    const carry_value_t i = carry_seeds[8], j = carry_seeds[9];
    const carry_value_t k = carry_seeds[10], l = carry_seeds[11];
    const carry_value_t m = carry_seeds[12], n = carry_seeds[13];
    const carry_value_t o = carry_seeds[14], p = carry_seeds[15];
#endif
    pid_t result = fork_at_depth(depth - 1);
    // WHY: keep each recursive activation live across fork so instrumentation
    // must save enough frames to request a second continuation chunk.
    __asm__ volatile("" : "+r"(depth));
#ifdef P11_WIDE_FRAME
    if (a != carry_seeds[0] || b != carry_seeds[1]
        || c != carry_seeds[2] || d != carry_seeds[3]
        || e != carry_seeds[4] || f != carry_seeds[5]
        || g != carry_seeds[6] || h != carry_seeds[7]
        || i != carry_seeds[8] || j != carry_seeds[9]
        || k != carry_seeds[10] || l != carry_seeds[11]
        || m != carry_seeds[12] || n != carry_seeds[13]
        || o != carry_seeds[14] || p != carry_seeds[15]) {
        static const char message[] = "FAIL: continuation carry values changed\n";
        write(STDERR_FILENO, message, sizeof(message) - 1);
        _exit(97);
    }
#endif
    return result + (depth == -1);
}

static int release_fillers(size_t count) {
    int failed = 0;
    for (size_t i = 0; i < count; i++) {
        if (munmap(filler_mappings[i], WASM_PAGE_BYTES) != 0) failed = 1;
    }
    return failed;
}

static int emit_marker(const char *text, size_t length) {
    while (length > 0) {
        const ssize_t written = write(STDOUT_FILENO, text, length);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) return -1;
        text += (size_t)written;
        length -= (size_t)written;
    }
    return 0;
}

static int prove_parent_syscalls_remain_usable(void) {
    int pipefd[2];
    char sent = 'K';
    char received = '\0';

    if (pipe(pipefd) != 0) return -1;
    if (write(pipefd[1], &sent, 1) != 1 || read(pipefd[0], &received, 1) != 1) {
        const int saved_errno = errno;
        close(pipefd[0]);
        close(pipefd[1]);
        errno = saved_errno;
        return -1;
    }
    const int read_close_result = close(pipefd[0]);
    const int read_close_errno = errno;
    const int write_close_result = close(pipefd[1]);
    if (read_close_result != 0) {
        errno = read_close_errno;
        return -1;
    }
    if (write_close_result != 0) {
        return -1;
    }
    if (received != sent) {
        errno = EIO;
        return -1;
    }
    return 0;
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
    if (filler_count < 2) {
        printf("FAIL: fewer than two filler mappings were available\n");
        return 1;
    }

    // WHY: leave the address space completely full for this first fork. Its
    // initial 64-KiB continuation mmap must fail before unwind starts, proving
    // the real worker-side root-allocation error path rather than only the
    // host arena unit.
    errno = 0;
    const pid_t root_failed_child = fork();
    const int root_fork_errno = errno;
    if (root_failed_child != -1 || root_fork_errno != ENOMEM) {
        printf(
            "FAIL: root-allocation fork result=%d errno=%d\n",
            (int)root_failed_child,
            root_fork_errno
        );
        release_fillers(filler_count);
        return 1;
    }
    if (getpid() != original_pid) {
        printf("FAIL: process identity changed after root-allocation failure\n");
        release_fillers(filler_count);
        return 1;
    }
    static const char root_enomem_marker[] = "ROOT_CONTINUATION_ENOMEM: ok\n";
    if (emit_marker(root_enomem_marker, sizeof(root_enomem_marker) - 1) != 0) {
        release_fillers(filler_count);
        return 1;
    }

    int status = 0;
    errno = 0;
    const pid_t root_phantom = waitpid(-1, &status, WNOHANG);
    if (root_phantom != -1 || errno != ECHILD) {
        printf(
            "FAIL: root-allocation failure left child=%d errno=%d\n",
            (int)root_phantom,
            errno
        );
        release_fillers(filler_count);
        return 1;
    }
    static const char no_phantom_marker[] = "ROOT_NO_PHANTOM_CHILD: ok\n";
    if (emit_marker(no_phantom_marker, sizeof(no_phantom_marker) - 1) != 0) {
        release_fillers(filler_count);
        return 1;
    }

    if (prove_parent_syscalls_remain_usable() != 0 || getpid() != original_pid) {
        printf("FAIL: parent unusable after root-allocation failure errno=%d\n", errno);
        release_fillers(filler_count);
        return 1;
    }
    static const char usable_marker[] = "ROOT_PARENT_USABLE: ok\n";
    if (emit_marker(usable_marker, sizeof(usable_marker) - 1) != 0) {
        release_fillers(filler_count);
        return 1;
    }

    // WHY: ABI 43 owns process/module/reference metadata separately from the
    // linked stack. Two free pages let capture allocate the metadata arena and
    // the continuation root. The deep call chain then needs a third page, so
    // failure occurs after frames have committed and exercises
    // ABORT_UNWINDING rather than the simpler root-allocation error path.
    for (int i = 0; i < 2; i++) {
        filler_count--;
        if (munmap(filler_mappings[filler_count], WASM_PAGE_BYTES) != 0) {
            printf(
                "FAIL: could not make fork transaction page available errno=%d\n",
                errno
            );
            release_fillers(filler_count);
            return 1;
        }
    }

    errno = 0;
    const pid_t failed_child = fork_at_depth(P11_RECURSION_DEPTH);
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

    status = 0;
    errno = 0;
    const pid_t phantom = waitpid(-1, &status, WNOHANG);
    if (phantom != -1 || errno != ECHILD) {
        printf("FAIL: failed fork left child=%d errno=%d\n", (int)phantom, errno);
        release_fillers(filler_count);
        return 1;
    }
    printf("NO_PHANTOM_CHILD: ok\n");

    // Abort replay must unmap both transaction roots and the partial linked
    // chain. Hold two probe mappings concurrently to prove both pages are
    // reusable before relying on them for the recovery fork.
    void *probes[2] = {MAP_FAILED, MAP_FAILED};
    for (int i = 0; i < 2; i++) {
        probes[i] = mmap(
            NULL,
            WASM_PAGE_BYTES,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
            -1,
            0
        );
        if (probes[i] == MAP_FAILED) {
            printf("FAIL: fork transaction allocation leaked errno=%d\n", errno);
            for (int j = 0; j < i; j++) {
                munmap(probes[j], WASM_PAGE_BYTES);
            }
            release_fillers(filler_count);
            return 1;
        }
    }
    for (int i = 0; i < 2; i++) {
        if (munmap(probes[i], WASM_PAGE_BYTES) != 0) {
            printf("FAIL: probe cleanup errno=%d\n", errno);
            release_fillers(filler_count);
            return 1;
        }
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
