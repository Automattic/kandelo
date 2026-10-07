/*
 * A SysV shared-memory attachment is a view of the segment, not a snapshot
 * taken at shmat() time. When a child writes the segment and then departs
 * (shmdt or exit), the parent's surviving attachment must show those bytes,
 * even though the parent is now the segment's only attacher.
 *
 * Each case uses its own segment. The parent writes a seed byte, forks, and
 * waits for the child with waitpid(). It then reads the segment through the
 * attachment it has held the whole time -- once right after waitpid() and
 * again after one more unrelated syscall -- without detaching or
 * reattaching.
 */
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <sys/wait.h>
#include <unistd.h>

#define SEG_SIZE 4096
#define PATTERN_LEN 64

enum child_mode {
    /* Child drops the inherited attachment, attaches anew, writes, shmdt()s. */
    CHILD_FRESH_ATTACH_THEN_SHMDT,
    /* Child attaches anew (keeping the inherited one), writes, exits. */
    CHILD_FRESH_ATTACH_NO_SHMDT,
    /* Child writes through the attachment it inherited from fork(), exits. */
    CHILD_INHERITED_ATTACH,
};

static const char *mode_name(enum child_mode mode) {
    switch (mode) {
    case CHILD_FRESH_ATTACH_THEN_SHMDT: return "fresh-attach-shmdt";
    case CHILD_FRESH_ATTACH_NO_SHMDT: return "fresh-attach-exit";
    case CHILD_INHERITED_ATTACH: return "inherited-attach-exit";
    }
    return "unknown";
}

static unsigned char pattern_byte(int seed, int i) {
    return (unsigned char)(seed * 31 + i * 7 + 1);
}

static void fill_pattern(unsigned char *dst, int seed) {
    for (int i = 0; i < PATTERN_LEN; i++) dst[i] = pattern_byte(seed, i);
}

static int check_pattern(const unsigned char *src, int seed, const char *when,
                         const char *name) {
    for (int i = 0; i < PATTERN_LEN; i++) {
        if (src[i] != pattern_byte(seed, i)) {
            printf("FAIL %s (%s): byte %d = 0x%02x, expected 0x%02x\n",
                   name, when, i, src[i], pattern_byte(seed, i));
            return 1;
        }
    }
    return 0;
}

static int run_case(enum child_mode mode, int seed) {
    const char *name = mode_name(mode);
    int shmid = shmget(IPC_PRIVATE, SEG_SIZE, IPC_CREAT | 0600);
    if (shmid < 0) {
        printf("FAIL %s: shmget: %s\n", name, strerror(errno));
        return 1;
    }
    unsigned char *parent_view = shmat(shmid, NULL, 0);
    if (parent_view == (void *)-1) {
        printf("FAIL %s: shmat: %s\n", name, strerror(errno));
        shmctl(shmid, IPC_RMID, NULL);
        return 1;
    }
    /* A parent write before fork, so the child's write must replace it. */
    memset(parent_view, 0xEE, PATTERN_LEN);

    pid_t pid = fork();
    if (pid < 0) {
        printf("FAIL %s: fork: %s\n", name, strerror(errno));
        shmdt(parent_view);
        shmctl(shmid, IPC_RMID, NULL);
        return 1;
    }
    if (pid == 0) {
        unsigned char *view = parent_view;
        if (mode == CHILD_FRESH_ATTACH_THEN_SHMDT) {
            if (shmdt(parent_view) != 0) _exit(10);
        }
        if (mode != CHILD_INHERITED_ATTACH) {
            view = shmat(shmid, NULL, 0);
            if (view == (void *)-1) _exit(11);
        }
        if (view[0] != 0xEE) _exit(12);
        fill_pattern(view, seed);
        if (mode == CHILD_FRESH_ATTACH_THEN_SHMDT) {
            if (shmdt(view) != 0) _exit(13);
        }
        /* No shmdt for the other modes: exit teardown is the detach. */
        _exit(0);
    }

    int status = 0;
    if (waitpid(pid, &status, 0) != pid) {
        printf("FAIL %s: waitpid: %s\n", name, strerror(errno));
        shmdt(parent_view);
        shmctl(shmid, IPC_RMID, NULL);
        return 1;
    }
    int failures = 0;
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        printf("FAIL %s: child status=0x%x\n", name, status);
        failures++;
    } else {
        failures += check_pattern(parent_view, seed, "after waitpid", name);
        /* One more syscall boundary: a stale view must not stay stale. */
        (void)getppid();
        failures += check_pattern(parent_view, seed, "after a later syscall",
                                  name);
    }

    struct shmid_ds ds;
    if (shmctl(shmid, IPC_STAT, &ds) != 0) {
        printf("FAIL %s: shmctl IPC_STAT: %s\n", name, strerror(errno));
        failures++;
    } else if (ds.shm_nattch != 1) {
        printf("FAIL %s: shm_nattch=%lu, expected 1\n", name,
               (unsigned long)ds.shm_nattch);
        failures++;
    }

    if (shmdt(parent_view) != 0) {
        printf("FAIL %s: shmdt: %s\n", name, strerror(errno));
        failures++;
    }
    if (shmctl(shmid, IPC_RMID, NULL) != 0) {
        printf("FAIL %s: shmctl IPC_RMID: %s\n", name, strerror(errno));
        failures++;
    }
    if (failures == 0) printf("%s: PASS\n", name);
    return failures;
}

int main(void) {
    int failures = 0;
    failures += run_case(CHILD_FRESH_ATTACH_THEN_SHMDT, 1);
    failures += run_case(CHILD_FRESH_ATTACH_NO_SHMDT, 2);
    failures += run_case(CHILD_INHERITED_ATTACH, 3);
    if (failures == 0) printf("SYSV_DEPARTED_PEER_PASS\n");
    return failures == 0 ? 0 : 1;
}
