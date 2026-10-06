/*
 * Malformed or contradictory syscall-channel requests fail only the process
 * that sent them.
 *
 * libc's glue normally writes every channel request. A process can also write
 * its own channel directly, so the host and the kernel must treat the request
 * header and the opaque argument record as untrusted input: a bad request is
 * answered with an errno to that one syscall, and no other process notices.
 *
 * Each case runs in its own forked child, which writes one crafted request
 * straight into its channel and reports the result. The parent waits for each
 * child and then keeps making ordinary syscalls, so a kernel-wide failure
 * shows up as the parent never reaching its final PASS line.
 *
 * The channel layout mirrors crates/shared/src/lib.rs `channel` (also
 * projected into libc/glue/abi_constants.h); the record layout comes from
 * <bits/kandelo_syscall_marshal.h>.
 */
#include <bits/kandelo_syscall_marshal.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#define CH_STATUS 0u
#define CH_SYSCALL 4u
#define CH_ARGS 8u
#define CH_ARG_SIZE 8u
#define CH_RETURN 56u
#define CH_ERRNO 64u
#define CH_REQUEST_FLAGS 68u
#define CH_DATA 72u
#define CH_IDLE 0
#define CH_PENDING 1
#define CH_REQUEST_FLAG_OPAQUE_RECORD 8u

#if __SIZEOF_POINTER__ == 8
__asm__(".globaltype __channel_base, i64\n");
#else
__asm__(".globaltype __channel_base, i32\n");
#endif

static uintptr_t channel_base(void) {
    uintptr_t base;
    __asm__ volatile("global.get __channel_base\n"
                     "local.set %0" : "=r"(base));
    return base;
}

struct reply {
    long long ret;
    int err;
};

/* Publish one request exactly as libc's glue does, but with caller-chosen
 * header flags and data-region bytes. */
static struct reply crafted_request(uint32_t nr, const long long args[6],
                                    uint32_t flags, const void *data,
                                    size_t data_len) {
    uintptr_t base = channel_base();
    if (data_len > 0)
        memcpy((void *)(base + CH_DATA), data, data_len);
    *(volatile uint32_t *)(base + CH_SYSCALL) = nr;
    for (int i = 0; i < 6; i++)
        *(volatile int64_t *)(base + CH_ARGS + i * CH_ARG_SIZE) = args[i];
    *(volatile uint32_t *)(base + CH_REQUEST_FLAGS) = flags;
    __c11_atomic_store((_Atomic int32_t *)(base + CH_STATUS), CH_PENDING,
                       __ATOMIC_SEQ_CST);
    __builtin_wasm_memory_atomic_notify((int32_t *)(base + CH_STATUS), 1);
    while (__builtin_wasm_memory_atomic_wait32(
               (int32_t *)(base + CH_STATUS), CH_PENDING, -1) == 0) {
    }
    struct reply reply = {
        .ret = *(volatile int64_t *)(base + CH_RETURN),
        .err = *(volatile int32_t *)(base + CH_ERRNO),
    };
    __c11_atomic_store((_Atomic int32_t *)(base + CH_STATUS), CH_IDLE,
                       __ATOMIC_SEQ_CST);
    return reply;
}

/* A record header with no spans. It states its own length, so each case
 * below is refused for the defect it names rather than for a zero length. */
static void record_header(uint8_t out[KANDELO_RECORD_HEADER_BYTES],
                          uint16_t record_abi, uint16_t syscall_nr) {
    uint32_t magic = KANDELO_RECORD_MAGIC;
    uint32_t record_len = KANDELO_RECORD_HEADER_BYTES;
    memset(out, 0, KANDELO_RECORD_HEADER_BYTES);
    memcpy(out + KANDELO_RECORD_H_MAGIC, &magic, sizeof magic);
    memcpy(out + KANDELO_RECORD_H_RECORD_ABI, &record_abi, sizeof record_abi);
    memcpy(out + KANDELO_RECORD_H_SYSCALL, &syscall_nr, sizeof syscall_nr);
    memcpy(out + KANDELO_RECORD_H_RECORD_LEN, &record_len, sizeof record_len);
}

static const long long no_args[6];

/* Each case returns 0 when the outcome is the truthful per-process one. */
static int expect_einval(const char *name, struct reply reply) {
    printf("%s: ret=%lld errno=%d\n", name, reply.ret, reply.err);
    fflush(stdout);
    return reply.ret == -1 && reply.err == EINVAL ? 0 : 1;
}

static int case_unknown_flag(void) {
    return expect_einval("unknown-flag",
                         crafted_request(SYS_getpid, no_args, 1u << 7, 0, 0));
}

static int case_record_flag_without_record(void) {
    /* Clear any record magic a previous request left in the data region. */
    uint8_t zero[KANDELO_RECORD_HEADER_BYTES] = {0};
    return expect_einval(
        "record-flag-without-record",
        crafted_request(SYS_getpid, no_args, CH_REQUEST_FLAG_OPAQUE_RECORD,
                        zero, sizeof zero));
}

static int case_record_syscall_mismatch(void) {
    uint8_t record[KANDELO_RECORD_HEADER_BYTES];
    record_header(record, KANDELO_RECORD_ABI, SYS_getppid);
    return expect_einval(
        "record-syscall-mismatch",
        crafted_request(SYS_getpid, no_args, CH_REQUEST_FLAG_OPAQUE_RECORD,
                        record, sizeof record));
}

static int case_record_bad_abi(void) {
    uint8_t record[KANDELO_RECORD_HEADER_BYTES];
    record_header(record, 99, SYS_getpid);
    return expect_einval(
        "record-bad-abi",
        crafted_request(SYS_getpid, no_args, CH_REQUEST_FLAG_OPAQUE_RECORD,
                        record, sizeof record));
}

/* The record frames itself; a length shorter than its own header, or one
 * past the inline budget, is a malformed request, not a cue to read scratch
 * the host never copied. */
static int case_record_bad_length(void) {
    uint8_t record[KANDELO_RECORD_HEADER_BYTES];
    int failures = 0;
    const uint32_t lengths[] = {0u, KANDELO_RECORD_HEADER_BYTES - 1u,
                                KANDELO_RECORD_INLINE_BUDGET + 1u};
    for (unsigned i = 0; i < sizeof lengths / sizeof lengths[0]; i++) {
        record_header(record, KANDELO_RECORD_ABI, SYS_getpid);
        memcpy(record + KANDELO_RECORD_H_RECORD_LEN, &lengths[i],
               sizeof lengths[i]);
        failures += expect_einval(
            "record-bad-length",
            crafted_request(SYS_getpid, no_args,
                            CH_REQUEST_FLAG_OPAQUE_RECORD, record,
                            sizeof record));
    }
    return failures;
}

static int case_raw_syscall_with_record_flag(void) {
    /* write(2) keeps raw arguments; a record flag on it is contradictory. */
    uint8_t record[KANDELO_RECORD_HEADER_BYTES];
    long long args[6] = {1, 0, 0, 0, 0, 0};
    record_header(record, KANDELO_RECORD_ABI, SYS_write);
    return expect_einval(
        "raw-syscall-with-record-flag",
        crafted_request(SYS_write, args, CH_REQUEST_FLAG_OPAQUE_RECORD,
                        record, sizeof record));
}

/* Ordinary libc path: user data that happens to begin with the record magic
 * is data, not a request. */
static int case_payload_looks_like_record(void) {
    int fds[2];
    uint8_t payload[KANDELO_RECORD_HEADER_BYTES];
    uint8_t echoed[sizeof payload];
    record_header(payload, KANDELO_RECORD_ABI, SYS_getppid);
    if (pipe(fds) != 0) {
        perror("pipe");
        return 1;
    }
    ssize_t wrote = write(fds[1], payload, sizeof payload);
    int write_errno = errno;
    ssize_t got = wrote == (ssize_t)sizeof payload
        ? read(fds[0], echoed, sizeof echoed)
        : -1;
    printf("payload-looks-like-record: write=%zd errno=%d read=%zd\n", wrote,
           wrote < 0 ? write_errno : 0, got);
    fflush(stdout);
    close(fds[0]);
    close(fds[1]);
    return wrote == (ssize_t)sizeof payload && got == (ssize_t)sizeof payload
            && memcmp(payload, echoed, sizeof payload) == 0
        ? 0
        : 1;
}

static int run_in_child(const char *name, int (*fn)(void)) {
    pid_t pid = fork();
    if (pid < 0) {
        perror("fork");
        return 1;
    }
    if (pid == 0)
        _exit(fn());
    int status = 0;
    if (waitpid(pid, &status, 0) != pid) {
        perror("waitpid");
        return 1;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        printf("FAIL %s: child status 0x%x\n", name, status);
        fflush(stdout);
        return 1;
    }
    return 0;
}

int main(void) {
    int failures = 0;
    failures += run_in_child("unknown-flag", case_unknown_flag);
    failures += run_in_child("record-flag-without-record",
                             case_record_flag_without_record);
    failures += run_in_child("record-syscall-mismatch",
                             case_record_syscall_mismatch);
    failures += run_in_child("record-bad-abi", case_record_bad_abi);
    failures += run_in_child("record-bad-length", case_record_bad_length);
    failures += run_in_child("payload-looks-like-record",
                             case_payload_looks_like_record);
    failures += run_in_child("raw-syscall-with-record-flag",
                             case_raw_syscall_with_record_flag);
    /* The parent is the "other process": it must still be served. */
    if (getpid() <= 0)
        failures++;
    if (failures != 0) {
        printf("FAIL %d case(s)\n", failures);
        return 1;
    }
    printf("PASS channel requests fail per process\n");
    return 0;
}
