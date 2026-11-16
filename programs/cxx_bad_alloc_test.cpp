// operator new failure reporting (host/test/cxx-terminate.test.ts).
//
// A throwing operator new that cannot allocate calls the new_handler and,
// when there is none, throws std::bad_alloc; the nothrow forms return a null
// pointer instead ([new.delete.single], [new.delete.array]). These come from
// libc++. The SDK's minimal C++ runtime (libc/glue/cxxrt.c), which aborts on
// failure, must only supply operator new to programs linked without libc++.
//
// Two kinds of failure are requested, neither of which consumes memory:
//   - a size musl's malloc rejects before asking the kernel (above
//     SIZE_MAX / 2), and
//   - a size malloc accepts but the kernel cannot map: larger than the
//     executable's 1 GiB memory maximum (crates/kandelo-cc/src/flags.rs).
//
// Expected output on PASS:
//   PASS cxx_bad_alloc_test
#include <cstdint>
#include <cstdio>
#include <initializer_list>
#include <new>

static int failures = 0;

static void check(bool ok, const char* what) {
    if (!ok) {
        std::printf("FAIL %s\n", what);
        failures++;
    }
}

static const std::size_t kRejected = SIZE_MAX / 2 + 1;
static const std::size_t kUnmappable = std::size_t(3) << 29;  // 1.5 GiB

// Keep the compiler from folding a call with an impossible size.
static volatile std::size_t sink;

template <typename F>
static bool throws_bad_alloc(F allocate) {
    try {
        void* p = allocate();
        sink = reinterpret_cast<std::uintptr_t>(p);
        return false;
    } catch (const std::bad_alloc&) {
        return true;
    }
}

static int handler_calls = 0;
static void new_handler() {
    handler_calls++;
    // A handler that cannot free memory gives up; operator new then throws.
    std::set_new_handler(nullptr);
}

int main() {
    for (std::size_t size : {kRejected, kUnmappable}) {
        const bool rejected = size == kRejected;
        check(throws_bad_alloc([&] { return ::operator new(size); }),
              rejected ? "operator new (rejected size)" : "operator new (unmappable size)");
        check(throws_bad_alloc([&] { return ::operator new[](size); }),
              rejected ? "operator new[] (rejected size)" : "operator new[] (unmappable size)");
        check(throws_bad_alloc([&] { return ::operator new(size, std::align_val_t(64)); }),
              rejected ? "aligned operator new (rejected size)" : "aligned operator new (unmappable size)");
        check(::operator new(size, std::nothrow) == nullptr,
              rejected ? "nothrow operator new (rejected size)" : "nothrow operator new (unmappable size)");
        check(::operator new[](size, std::nothrow) == nullptr,
              rejected ? "nothrow operator new[] (rejected size)" : "nothrow operator new[] (unmappable size)");
        check(::operator new(size, std::align_val_t(64), std::nothrow) == nullptr,
              rejected ? "nothrow aligned operator new (rejected size)"
                       : "nothrow aligned operator new (unmappable size)");
    }

    // The new-expression form, as ordinary code writes it.
    volatile std::size_t count = kUnmappable;
    check(throws_bad_alloc([&] { return static_cast<void*>(new char[count]); }),
          "new char[n]");
    char* none = new (std::nothrow) char[count];
    // An escaping result keeps the compiler from eliding the allocation.
    sink = reinterpret_cast<std::uintptr_t>(none);
    check(none == nullptr, "new (std::nothrow) char[n]");

    // operator new calls the installed new_handler before giving up.
    std::set_new_handler(new_handler);
    check(throws_bad_alloc([&] { return ::operator new(kUnmappable); }),
          "operator new with a new_handler");
    check(handler_calls == 1, "new_handler called once");

    // Allocation still works after the failures.
    int* value = new int(7);
    check(value != nullptr && *value == 7, "allocation after failure");
    delete value;

    if (failures) return 1;
    std::printf("PASS cxx_bad_alloc_test\n");
    return 0;
}
