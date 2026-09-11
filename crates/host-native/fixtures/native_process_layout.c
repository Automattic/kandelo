/*
 * B24: channel-level coverage for the caller-native ("process layout") record
 * syscalls.
 *
 * Twelve-plus syscalls carry at least one pointer argument whose record size
 * is a property of the CALLING PROCESS's data model rather than of the call:
 * `SYSCALL_ARG_DESCRIPTORS` marks those arguments `SyscallArgSize::
 * ProcessLayout { wasm32_size, wasm64_size }`, and both the host (choosing how
 * many bytes to stage) and the kernel (choosing how to parse them) must select
 * the same one. Nothing exercised that agreement THROUGH THE CHANNEL: the
 * `runtime-core` tests call `syscalls::` directly, below the dispatcher, and
 * the TypeScript host suites mock `kernel_handle_channel`. A pointer-width
 * regression that made every one of these return EINVAL to every caller left
 * the whole suite green.
 *
 * This fixture runs each of them against the real kernel through the real
 * channel and checks a PLAUSIBLE RECORD, not merely a non-error return. A test
 * that only asserted "not EINVAL" would pass against several plausible wrong
 * implementations -- most obviously one that staged the record but never
 * filled it.
 *
 * TWO PROPERTIES ARE CHECKED PER OUTPUT RECORD:
 *
 *   1. CONTENT. Fields are compared against the kernel's own compiled-in
 *      values (`crates/runtime-core`: `rootfs::statfs`, `sys_sysinfo`) or
 *      against values this program itself supplied earlier in the run, so the
 *      bytes have to have made the whole round trip.
 *
 *   2. EXTENT, via a CANARY. Each output record is embedded in a struct with a
 *      known byte pattern immediately after it, so any write that runs past
 *      the record into the caller's memory is caught rather than silently
 *      accepted. Note what this does and does not reach: only three of these
 *      syscalls keep RAW arguments (`rt_sigqueueinfo`, `rt_sigtimedwait`,
 *      `waitid` -- see `crates/shared/src/host_raw_syscalls.rs`), and only for
 *      those does the HOST copy a descriptor-sized span back into guest
 *      memory. The other ten ride the opaque record path, where the guest glue
 *      sizes its own spans and the host is out of the data path entirely; a
 *      kernel-side size error there corrupts the channel record rather than
 *      overrunning this struct. The canary is a cheap standing guard on the
 *      host copy-back extent, not the thing that catches a width error.
 *
 *      WHAT CATCHES A WIDTH ERROR IS THE CONTENT CHECKS. Verified by building
 *      a kernel whose `current_caller_pointer_width` reports 8 for a wasm32
 *      caller: this fixture fails at exit code 4 on the very first record,
 *      `statfs`, because the fields parse at the wrong offsets.
 *
 * Every check that fails returns a distinct exit code so a red run names the
 * syscall and the property, and each success prints one line. The Rust test
 * asserts the exact output block, and separately derives the set of syscalls
 * that MUST appear here from `SYSCALL_ARG_DESCRIPTORS` itself -- so adding a
 * process-layout descriptor without adding coverage here fails the build.
 *
 * Built through the SDK like the other fixtures; see fixtures/README.md.
 */
#include <errno.h>
#include <fcntl.h>
#include <mqueue.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/statfs.h>
#include <sys/sysinfo.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define CANARY_BYTE 0xA5
#define CANARY_LEN 32

/* An output record plus a trailing byte pattern the kernel must not touch. */
#define WITH_CANARY(type, name)          \
    struct {                             \
        type record;                     \
        unsigned char canary[CANARY_LEN];\
    } name

static void arm_canary(unsigned char *canary) {
    memset(canary, CANARY_BYTE, CANARY_LEN);
}

static int canary_intact(const unsigned char *canary) {
    for (int i = 0; i < CANARY_LEN; i++) {
        if (canary[i] != CANARY_BYTE) {
            return 0;
        }
    }
    return 1;
}

static void emit(const char *line) {
    write(1, line, strlen(line));
}

int main(void) {
    char out[160];

    /*
     * statfs / fstatfs -- `struct statfs` Out record.
     *
     * `/` is owned by the in-kernel rootfs overlay, so the values below are
     * `crates/runtime-core/src/rootfs.rs`'s compiled-in constants. Comparing
     * against them proves the kernel's bytes reached this struct, not that
     * some zeroed scratch did.
     */
    WITH_CANARY(struct statfs, sfs);
    memset(&sfs, 0, sizeof sfs);
    arm_canary(sfs.canary);
    if (statfs("/", &sfs.record) != 0) {
        return 2;
    }
    if (!canary_intact(sfs.canary)) {
        return 3;
    }
    if (sfs.record.f_bsize != 4096 || sfs.record.f_namelen != 255 ||
        sfs.record.f_blocks != 262144 || sfs.record.f_frsize != 4096) {
        return 4;
    }
    snprintf(out, sizeof out, "statfs: bsize=%ld frsize=%ld namelen=%ld blocks=%lld\n",
             (long)sfs.record.f_bsize, (long)sfs.record.f_frsize,
             (long)sfs.record.f_namelen, (long long)sfs.record.f_blocks);
    emit(out);

    int rootfd = open("/", O_RDONLY);
    if (rootfd < 0) {
        return 5;
    }
    WITH_CANARY(struct statfs, ffs);
    memset(&ffs, 0, sizeof ffs);
    arm_canary(ffs.canary);
    if (fstatfs(rootfd, &ffs.record) != 0) {
        return 6;
    }
    if (!canary_intact(ffs.canary)) {
        return 7;
    }
    /* Same filesystem as the path form: the two must agree field for field. */
    if (ffs.record.f_bsize != sfs.record.f_bsize ||
        ffs.record.f_namelen != sfs.record.f_namelen ||
        ffs.record.f_blocks != sfs.record.f_blocks) {
        return 8;
    }
    snprintf(out, sizeof out, "fstatfs: bsize=%ld namelen=%ld blocks=%lld\n",
             (long)ffs.record.f_bsize, (long)ffs.record.f_namelen,
             (long long)ffs.record.f_blocks);
    emit(out);

    /*
     * sysinfo -- `struct sysinfo` Out record (312 bytes at wasm32).
     * Values are `crates/runtime-core/src/syscalls.rs`'s `sys_sysinfo`.
     */
    WITH_CANARY(struct sysinfo, sinf);
    memset(&sinf, 0, sizeof sinf);
    arm_canary(sinf.canary);
    if (sysinfo(&sinf.record) != 0) {
        return 9;
    }
    if (!canary_intact(sinf.canary)) {
        return 10;
    }
    if (sinf.record.totalram != 512UL * 1024 * 1024 ||
        sinf.record.freeram != 256UL * 1024 * 1024 || sinf.record.procs != 1 ||
        sinf.record.mem_unit != 1 || sinf.record.uptime != 1) {
        return 11;
    }
    snprintf(out, sizeof out, "sysinfo: totalram=%lu freeram=%lu procs=%u unit=%u\n",
             (unsigned long)sinf.record.totalram, (unsigned long)sinf.record.freeram,
             (unsigned)sinf.record.procs, (unsigned)sinf.record.mem_unit);
    emit(out);

    /*
     * sigaltstack -- `stack_t` In AND Out records (12 bytes at wasm32, 24 at
     * wasm64: the width-sensitive case). The first call reads the untouched
     * initial state (SS_DISABLE, no stack); the second installs a stack and
     * must report the FIRST call's state back, which only works if the In
     * record was parsed at the caller's size.
     */
    WITH_CANARY(stack_t, oss0);
    memset(&oss0, 0, sizeof oss0);
    arm_canary(oss0.canary);
    if (sigaltstack(NULL, &oss0.record) != 0) {
        return 12;
    }
    if (!canary_intact(oss0.canary)) {
        return 13;
    }
    if (oss0.record.ss_flags != SS_DISABLE || oss0.record.ss_size != 0) {
        return 14;
    }

    static char altstack[SIGSTKSZ < 65536 ? 65536 : SIGSTKSZ];
    stack_t ss;
    memset(&ss, 0, sizeof ss);
    ss.ss_sp = altstack;
    ss.ss_size = sizeof altstack;
    ss.ss_flags = 0;
    WITH_CANARY(stack_t, oss1);
    memset(&oss1, 0, sizeof oss1);
    arm_canary(oss1.canary);
    if (sigaltstack(&ss, &oss1.record) != 0) {
        return 15;
    }
    if (!canary_intact(oss1.canary)) {
        return 16;
    }
    if (oss1.record.ss_flags != SS_DISABLE) {
        return 17;
    }
    /* Read back what the In record installed: proves the In parse, not just
     * that the call returned 0. */
    WITH_CANARY(stack_t, oss2);
    memset(&oss2, 0, sizeof oss2);
    arm_canary(oss2.canary);
    if (sigaltstack(NULL, &oss2.record) != 0) {
        return 18;
    }
    if (!canary_intact(oss2.canary)) {
        return 19;
    }
    if (oss2.record.ss_size != sizeof altstack || oss2.record.ss_sp != altstack) {
        return 20;
    }
    snprintf(out, sizeof out, "sigaltstack: installed size=%lu readback=%lu\n",
             (unsigned long)sizeof altstack, (unsigned long)oss2.record.ss_size);
    emit(out);

    /*
     * setitimer / getitimer -- `struct itimerval` records (16 bytes at wasm32,
     * 32 at wasm64: width-sensitive).
     *
     * ITIMER_VIRTUAL, not ITIMER_REAL. ITIMER_REAL reaches `host_set_alarm`,
     * which this native host deliberately leaves to
     * `define_unknown_imports_as_traps` (it has no SIGALRM delivery to offer,
     * and a host stub that accepted the request and never delivered would be
     * the dishonest kind). ITIMER_VIRTUAL is a kernel-side no-op that still
     * parses the In record and writes the Out record at the caller-native
     * size, so the marshalling contract is exercised; the VALUE round trip
     * for ITIMER_REAL is not reachable on this host and is not claimed here.
     */
    struct itimerval nv;
    memset(&nv, 0, sizeof nv);
    nv.it_value.tv_sec = 100;
    nv.it_interval.tv_sec = 7;
    WITH_CANARY(struct itimerval, oitv);
    memset(&oitv, 0xFF, sizeof oitv.record);
    arm_canary(oitv.canary);
    if (setitimer(ITIMER_VIRTUAL, &nv, &oitv.record) != 0) {
        return 21;
    }
    if (!canary_intact(oitv.canary)) {
        return 22;
    }
    /* Pre-filled with 0xFF: zeros here prove the kernel WROTE the whole
     * record rather than leaving the caller's bytes in place. */
    if (oitv.record.it_value.tv_sec != 0 || oitv.record.it_value.tv_usec != 0 ||
        oitv.record.it_interval.tv_sec != 0 || oitv.record.it_interval.tv_usec != 0) {
        return 23;
    }
    WITH_CANARY(struct itimerval, citv);
    memset(&citv, 0xFF, sizeof citv.record);
    arm_canary(citv.canary);
    if (getitimer(ITIMER_VIRTUAL, &citv.record) != 0) {
        return 24;
    }
    if (!canary_intact(citv.canary)) {
        return 25;
    }
    if (citv.record.it_value.tv_sec != 0 || citv.record.it_value.tv_usec != 0 ||
        citv.record.it_interval.tv_sec != 0 || citv.record.it_interval.tv_usec != 0) {
        return 26;
    }
    emit("setitimer: old record cleared\ngetitimer: record cleared\n");

    /*
     * timer_create -- `struct sigevent` In record (64 bytes at both models).
     * A non-NULL sigevent is required: the descriptor is nullable, and a NULL
     * one skips the staging path this test exists to cover.
     */
    struct sigevent sev;
    memset(&sev, 0, sizeof sev);
    sev.sigev_notify = SIGEV_SIGNAL;
    sev.sigev_signo = SIGUSR1;
    timer_t timerid;
    if (timer_create(CLOCK_MONOTONIC, &sev, &timerid) != 0) {
        return 27;
    }
    emit("timer_create: created from sigevent\n");

    /*
     * rt_sigqueueinfo (In) and rt_sigtimedwait (Out) -- `siginfo_t` records,
     * 128 bytes at both models.
     *
     * These two are a matched pair and the strongest content check available:
     * the `sigval` this process queues through the In record must come back
     * out of the Out record. A staged-but-unfilled record, or a record parsed
     * at the wrong offset, loses the value.
     */
    sigset_t set;
    sigemptyset(&set);
    sigaddset(&set, SIGUSR2);
    if (sigprocmask(SIG_BLOCK, &set, NULL) != 0) {
        return 28;
    }
    union sigval sv;
    sv.sival_int = 4242;
    if (sigqueue(getpid(), SIGUSR2, sv) != 0) {
        return 29;
    }
    WITH_CANARY(siginfo_t, si);
    memset(&si, 0, sizeof si);
    arm_canary(si.canary);
    struct timespec zero = {0, 0};
    if (sigtimedwait(&set, &si.record, &zero) != SIGUSR2) {
        return 30;
    }
    if (!canary_intact(si.canary)) {
        return 31;
    }
    if (si.record.si_signo != SIGUSR2 || si.record.si_value.sival_int != 4242) {
        return 32;
    }
    snprintf(out, sizeof out, "rt_sigqueueinfo+rt_sigtimedwait: signo=%d sival=%d\n",
             si.record.si_signo, si.record.si_value.sival_int);
    emit(out);

    /*
     * mq_open (In `struct mq_attr`) and mq_getsetattr (In and Out `struct
     * mq_attr`) -- 32 bytes at wasm32, 64 at wasm64: width-sensitive.
     *
     * The attributes handed to `mq_open` must come back out of `mq_getattr`,
     * so the In record of one syscall and the Out record of another have to
     * agree on the same layout.
     */
    struct mq_attr want;
    memset(&want, 0, sizeof want);
    want.mq_maxmsg = 4;
    want.mq_msgsize = 32;
    mqd_t q = mq_open("/b24-process-layout", O_CREAT | O_RDWR, 0600, &want);
    if (q == (mqd_t)-1) {
        return 33;
    }
    WITH_CANARY(struct mq_attr, got);
    memset(&got, 0, sizeof got);
    arm_canary(got.canary);
    if (mq_getattr(q, &got.record) != 0) {
        return 34;
    }
    if (!canary_intact(got.canary)) {
        return 35;
    }
    if (got.record.mq_maxmsg != 4 || got.record.mq_msgsize != 32 ||
        got.record.mq_curmsgs != 0) {
        return 36;
    }
    snprintf(out, sizeof out, "mq_open+mq_getsetattr: maxmsg=%ld msgsize=%ld curmsgs=%ld\n",
             (long)got.record.mq_maxmsg, (long)got.record.mq_msgsize,
             (long)got.record.mq_curmsgs);
    emit(out);

    /*
     * mq_notify -- `struct sigevent` In record. Nullable in the descriptor and
     * a NULL one means "unregister", which skips staging entirely, so this
     * registers with a real sigevent and then unregisters.
     */
    struct sigevent nev;
    memset(&nev, 0, sizeof nev);
    nev.sigev_notify = SIGEV_SIGNAL;
    nev.sigev_signo = SIGUSR1;
    if (mq_notify(q, &nev) != 0) {
        return 37;
    }
    /* Registering twice must fail with EBUSY: proof the FIRST sigevent was
     * actually parsed and recorded, not merely accepted and dropped. */
    if (mq_notify(q, &nev) == 0 || errno != EBUSY) {
        return 38;
    }
    emit("mq_notify: registered from sigevent\n");

    /*
     * waitid -- `siginfo_t` Out record.
     *
     * DOCUMENTED BOUNDARY, not coverage. `waitid` carries a process-layout
     * descriptor, so it belongs in this fixture's set, but the Rust kernel has
     * no dispatch arm for it: child matching for `waitid` still lives in the
     * TypeScript host (`host/src/kernel-worker.ts`, `SYS_WAITID`), so on this
     * native host it reaches the kernel and returns ENOSYS.
     *
     * Asserting ENOSYS -- rather than skipping the call -- is what keeps this
     * honest. The syscall is still DISPATCHED, so the descriptor-derived guard
     * in the Rust test sees it; and on the day `waitid` moves into the Rust
     * kernel, THIS assertion fails and forces real coverage to be written in
     * its place instead of the gap quietly closing unnoticed.
     */
    WITH_CANARY(siginfo_t, wi);
    memset(&wi, 0, sizeof wi);
    arm_canary(wi.canary);
    if (waitid(P_ALL, 0, &wi.record, WEXITED | WNOHANG) != -1 || errno != ENOSYS) {
        return 39;
    }
    if (!canary_intact(wi.canary)) {
        return 40;
    }
    emit("waitid: ENOSYS (still TypeScript-host-owned)\n");

    return 0;
}
