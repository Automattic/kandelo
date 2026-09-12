/*
 * Sequential pthread create/join churn, proving that per-thread resources are
 * a *concurrency* limit and not a lifetime budget.
 *
 * POSIX makes the distinction explicit. `pthread_create` "shall fail" with
 * EAGAIN when "the system lacked the necessary resources to create another
 * thread, or the system-imposed limit on the total number of threads in a
 * process {PTHREAD_THREADS_MAX} would be exceeded". Both clauses are about
 * threads that exist *now*: a joined thread no longer counts against either,
 * so a create/join loop must run for as long as the caller cares to run it.
 * A host that instead spends a resource per thread ever created is imposing a
 * cumulative quota POSIX does not sanction, and a long-running program that
 * uses a worker thread per unit of work dies partway through for no reason it
 * can observe or avoid.
 *
 * Only one thread is ever live, so the true concurrency high-water mark is 1.
 * Each round asserts its thread actually ran before joining, so a host that
 * "succeeds" by never launching the thread fails here too.
 *
 * THREAD_ROUNDS is 17 to clear two distinct limits measured on the native
 * Wasmtime host, one behind the other:
 *
 *   round 2  -- musl's thread-list lock deadlocks when the kernel does not
 *               honour CLONE_PARENT_SETTID, so `struct pthread.tid` stays 0
 *               and `__tl_lock` mistakes a fresh acquisition for a recursive
 *               one. This capped the host at exactly one pthread per process.
 *   round 17 -- the pthread slot arena reserved 16 slots per process and
 *               never returned a joined thread's slot to the pool.
 *
 * Neither number is a contract, and nothing may treat 17 as a supported
 * maximum; they are the two thresholds this fixture has to cross to be
 * evidence rather than decoration.
 *
 * Written with write(2) rather than stdio so the two hosts' fixture builds
 * behave identically and no buffered output is lost when a round aborts.
 */
#include <pthread.h>
#include <stdatomic.h>
#include <string.h>
#include <unistd.h>

#define THREAD_ROUNDS 17

static void *mark_started(void *opaque)
{
    atomic_store_explicit((atomic_int *)opaque, 1, memory_order_release);
    return (void *)0;
}

static void emit(const char *text)
{
    (void)write(1, text, strlen(text));
}

/* Two decimal digits is enough for THREAD_ROUNDS and avoids pulling in
 * snprintf, which the native fixture build does not link stdio for. */
static void emit_round(const char *prefix, int round)
{
    char buf[8];
    buf[0] = (char)('0' + (round / 10) % 10);
    buf[1] = (char)('0' + round % 10);
    buf[2] = '\n';
    emit(prefix);
    (void)write(1, buf, 3);
}

int main(void)
{
    for (int round = 1; round <= THREAD_ROUNDS; round++) {
        atomic_int started = 0;
        pthread_t thread;

        int error = pthread_create(&thread, (void *)0, mark_started, &started);
        if (error != 0) {
            emit_round("create-failed round ", round);
            /* EAGAIN is 11 on this platform; report the raw code so a wrong
             * errno is as visible as an outright abort. */
            emit_round("create-errno ", error);
            return 1;
        }

        if (pthread_join(thread, (void *)0) != 0) {
            emit_round("join-failed round ", round);
            return 2;
        }

        if (!atomic_load_explicit(&started, memory_order_acquire)) {
            emit_round("thread-did-not-run round ", round);
            return 3;
        }
    }

    emit("PTHREAD_SLOT_CHURN_PASS\n");
    return 0;
}
