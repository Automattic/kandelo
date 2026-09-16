/*
 * Concurrent pthreads, proving that a process's concurrent-thread ceiling is
 * the one the program declared and not the one a host happened to have room
 * for.
 *
 * `pthread-slot-churn.c` is the companion: it keeps one thread live at a time
 * and proves a joined thread's resources come back. This fixture is the other
 * half -- every thread stays live until the last one has started, so the
 * concurrency high-water mark really is THREAD_CONCURRENCY.
 *
 * THREAD_CONCURRENCY is 20 to clear, with margin, the 16 per-process control
 * slots the native Wasmtime host used to carve into a fixed arena below
 * `brk_base` at launch. That arena was a *host* limit: it made the native
 * host refuse a seventeenth concurrent thread with EAGAIN while the same
 * program ran fine under Node and in the browser, which reserve each slot from
 * the kernel's address-space allocator. Placement now lives in the kernel
 * (`sys_clone` -> `kernel_thread_slot_addr`) on every host, so every host
 * honours the program's `__wasm_posix_thread_slots` declaration -- the SDK
 * default is 1024 -- rather than its own capacity.
 *
 * 20 is not a contract and nothing may treat it as a supported maximum; it is
 * the threshold this fixture has to cross to be evidence rather than
 * decoration.
 *
 * Written with write(2) rather than stdio so the two hosts' fixture builds
 * behave identically and no buffered output is lost when a round aborts.
 */
#include <pthread.h>
#include <stdatomic.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define THREAD_CONCURRENCY 20

static atomic_int started_count = 0;
static atomic_int release_flag = 0;

static void nap(void)
{
    struct timespec ts = { .tv_sec = 0, .tv_nsec = 1000000 /* 1ms */ };
    (void)nanosleep(&ts, (void *)0);
}

static void *hold_until_released(void *opaque)
{
    (void)opaque;
    atomic_fetch_add_explicit(&started_count, 1, memory_order_acq_rel);
    /* Stay live. The point of the fixture is that all of these threads exist
     * at the same moment, so none may exit before the last one is created. */
    while (atomic_load_explicit(&release_flag, memory_order_acquire) == 0) {
        nap();
    }
    return (void *)0;
}

static void emit(const char *text)
{
    (void)write(1, text, strlen(text));
}

/* Two decimal digits is enough for THREAD_CONCURRENCY and avoids pulling in
 * snprintf, which the native fixture build does not link stdio for. */
static void emit_number(const char *prefix, int value)
{
    char buf[8];
    buf[0] = (char)('0' + (value / 10) % 10);
    buf[1] = (char)('0' + value % 10);
    buf[2] = '\n';
    emit(prefix);
    (void)write(1, buf, 3);
}

int main(void)
{
    pthread_t threads[THREAD_CONCURRENCY];
    int created = 0;

    for (; created < THREAD_CONCURRENCY; created++) {
        int error = pthread_create(
            &threads[created], (void *)0, hold_until_released, (void *)0);
        if (error != 0) {
            emit_number("create-failed at live thread ", created + 1);
            /* EAGAIN is 11 on this platform; report the raw code so a wrong
             * errno is as visible as an outright abort. */
            emit_number("create-errno ", error);
            atomic_store_explicit(&release_flag, 1, memory_order_release);
            for (int i = 0; i < created; i++) {
                (void)pthread_join(threads[i], (void *)0);
            }
            return 1;
        }
    }

    /* Every thread must have reached its body: a host that "succeeds" by
     * never launching a thread fails here. */
    while (atomic_load_explicit(&started_count, memory_order_acquire)
           < THREAD_CONCURRENCY) {
        nap();
    }

    atomic_store_explicit(&release_flag, 1, memory_order_release);
    for (int i = 0; i < THREAD_CONCURRENCY; i++) {
        if (pthread_join(threads[i], (void *)0) != 0) {
            emit_number("join-failed thread ", i + 1);
            return 2;
        }
    }

    emit("PTHREAD_CONCURRENT_SLOTS_PASS\n");
    return 0;
}
