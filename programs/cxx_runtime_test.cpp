// C++ runtime contract: every function a C++ program needs comes from the
// C++ runtime (libc++abi / libc++ / the SDK's cxxrt glue), never from the
// host. Before ABI 44 the host supplied JavaScript stand-ins for many of
// these, including a __cxa_thread_atexit that did nothing, so thread_local
// destructors silently never ran.
//
// Expected output on PASS:
//   PASS cxx runtime
#include <atomic>
#include <cstdio>
#include <new>
#include <pthread.h>

struct Base {
    virtual int f() = 0;
    virtual ~Base() = default;
};
struct Derived : Base {
    int f() override { return 7; }
};

static std::atomic<int> constructed{0};
struct Counted {
    Counted() { constructed++; }
};
// Function-local static: initialization is guarded by __cxa_guard_*.
static Counted& shared_instance() {
    static Counted c;
    return c;
}

static std::atomic<int> tls_destroyed{0};
struct TlsProbe {
    int touched = 0;
    ~TlsProbe() { tls_destroyed++; }
};
// Destroyed at thread exit through __cxa_thread_atexit.
static thread_local TlsProbe tls_probe;

static void* worker(void*) {
    shared_instance();
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

    pthread_t t[2];
    for (auto& th : t) pthread_create(&th, nullptr, worker, nullptr);
    for (auto& th : t) pthread_join(th, nullptr);
    if (constructed.load() != 1) {
        std::printf("FAIL static-local guard: constructed %d times\n", constructed.load());
        failures++;
    }
    if (tls_destroyed.load() != 2) {
        std::printf("FAIL thread_local destructors: ran %d of 2\n", tls_destroyed.load());
        failures++;
    }
    if (failures) return 1;
    std::puts("PASS cxx runtime");
    return 0;
}
