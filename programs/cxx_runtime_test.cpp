// C++ runtime contract: every function a C++ program needs comes from the
// C++ runtime (libc++abi / libc++ / the SDK's cxxrt glue), never from the
// host. Before ABI 46 the host supplied JavaScript stand-ins for many of
// these, including a __cxa_thread_atexit that did nothing, so thread_local
// destructors silently never ran.
//
// Expected output on PASS:
//   PASS cxx runtime
#include <atomic>
#include <cstdio>
#include <new>
#include <pthread.h>
#include <time.h>

struct Base {
    virtual int f() = 0;
    virtual ~Base() = default;
};
struct Derived : Base {
    int f() override { return 7; }
};

// Function-local static: initialization is guarded by __cxa_guard_*. The
// constructor is slow and every thread arrives together (barrier), so a
// guard that does not serialize would construct more than once, or let a
// caller return before construction finished (ready still 0).
static std::atomic<int> constructed{0};
static std::atomic<int> saw_unready{0};
struct Counted {
    std::atomic<int> ready{0};
    Counted() {
        constructed++;
        struct timespec pause = {0, 50 * 1000 * 1000};
        nanosleep(&pause, nullptr);
        ready.store(1);
    }
};
static Counted& shared_instance() {
    static Counted c;
    return c;
}

constexpr int kThreads = 8;
static pthread_barrier_t start_together;

static std::atomic<int> tls_destroyed{0};
struct TlsProbe {
    int touched = 0;
    ~TlsProbe() { tls_destroyed++; }
};
// Destroyed at thread exit through __cxa_thread_atexit.
static thread_local TlsProbe tls_probe;

static void* worker(void*) {
    pthread_barrier_wait(&start_together);
    if (shared_instance().ready.load() != 1) saw_unready++;
    tls_probe.touched = 1;
    return nullptr;
}

int main() {
    int failures = 0;
    int* p = new int(3);
    if (*p != 3) failures++;
    delete p;
    int* a = new int[4]{1, 2, 3, 4};
    if (a[3] != 4) failures++;
    delete[] a;
    int* nt = new (std::nothrow) int(5);
    if (!nt || *nt != 5) failures++;
    delete nt;
    Base* b = new Derived;
    if (!dynamic_cast<Derived*>(b) || b->f() != 7) failures++;
    delete b;

    pthread_barrier_init(&start_together, nullptr, kThreads);
    pthread_t t[kThreads];
    for (auto& th : t) pthread_create(&th, nullptr, worker, nullptr);
    for (auto& th : t) pthread_join(th, nullptr);
    pthread_barrier_destroy(&start_together);
    if (constructed.load() != 1 || saw_unready.load() != 0) {
        std::printf("FAIL static-local guard: constructed %d times, %d callers saw it unfinished\n",
                    constructed.load(), saw_unready.load());
        failures++;
    }
    if (tls_destroyed.load() != kThreads) {
        std::printf("FAIL thread_local destructors: ran %d of %d\n", tls_destroyed.load(), kThreads);
        failures++;
    }
    if (failures) return 1;
    std::puts("PASS cxx runtime");
    return 0;
}
