// C++ exceptions with the SDK's default flags (host/test/cpp-throw-test.test.ts).
// scripts/build-programs.sh compiles this with no exception flag at all:
// the SDK enables Wasm exception handling for C++ (docs/sdk-guide.md, "C++
// exceptions"), so software built by CMake, Meson or autotools gets working
// try/catch without knowing anything about Kandelo.
//
// Each check covers a separate part of the path: catch handlers in the
// program, destructors run while unwinding, exceptions thrown by libc++ and
// libc++abi code, exception_ptr across threads, and a catch handler inside
// libc++.a itself (std::call_once). Without exception handling in the
// program a throw ends it; without it in libc++ the second call_once below
// waits forever for a call that already failed, so a watchdog alarm turns
// that hang into a failure.
//
// Expected output on PASS:
//   PASS cpp_throw_test
#include <cstdio>
#include <cstring>
#include <exception>
#include <future>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

static int failures = 0;

static void check(bool ok, const char* what) {
    if (!ok) {
        std::printf("FAIL %s\n", what);
        failures++;
    }
}

struct Error : std::runtime_error {
    int code;
    Error(const char* message, int code) : std::runtime_error(message), code(code) {}
};

static int destroyed = 0;
struct Guard {
    ~Guard() { destroyed++; }
};

// Not inlined, so the throw crosses real call frames, each with a cleanup.
__attribute__((noinline)) static void throw_from_depth(int depth) {
    Guard guard;
    if (depth == 0) throw Error("deep", 42);
    throw_from_depth(depth - 1);
}

static int once_calls = 0;
static void once_body(bool fail) {
    once_calls++;
    if (fail) throw std::runtime_error("once");
}

int main() {
    alarm(20);

    // A catch handler in this program, matching by base class.
    try {
        throw Error("direct", 7);
    } catch (const std::exception& e) {
        check(std::strcmp(e.what(), "direct") == 0, "catch by base class");
    }

    // Unwinding runs every destructor between the throw and the handler.
    destroyed = 0;
    try {
        throw_from_depth(4);
        check(false, "throw_from_depth returned");
    } catch (const Error& e) {
        check(e.code == 42, "derived payload");
        check(destroyed == 5, "destructors run while unwinding");
    }

    // Rethrow, and exception_ptr carried to another thread and back.
    std::exception_ptr saved;
    try {
        try {
            throw 5;
        } catch (int) {
            throw;
        }
    } catch (int value) {
        check(value == 5, "rethrow");
        saved = std::current_exception();
    }
    std::promise<int> promise;
    std::future<int> future = promise.get_future();
    std::thread worker([&promise, saved] {
        try {
            std::rethrow_exception(saved);
        } catch (...) {
            promise.set_exception(std::current_exception());
        }
    });
    worker.join();
    try {
        future.get();
        check(false, "future.get() returned");
    } catch (int value) {
        check(value == 5, "exception_ptr across threads");
    }

    // Exceptions thrown by libc++ and libc++abi.
    std::vector<int> v(3);
    try {
        (void)v.at(10);
        check(false, "vector::at returned");
    } catch (const std::out_of_range&) {
    }
    try {
        (void)std::stoi("not a number");
        check(false, "stoi returned");
    } catch (const std::invalid_argument&) {
    }
    try {
        std::string s;
        s.reserve(s.max_size() + 1);
        check(false, "string::reserve returned");
    } catch (const std::length_error&) {
    }
    // Not checked here: a failed throwing operator new. The SDK glue's weak
    // fallback (libc/glue/cxxrt.c) satisfies operator new before the link
    // reaches libc++'s, and it aborts instead of throwing std::bad_alloc
    // (docs/posix-status.md, "C++ exception support").

    // A handler inside libc++.a: call_once resets its flag when the call
    // throws, so the next call_once runs again.
    std::once_flag flag;
    try {
        std::call_once(flag, once_body, true);
        check(false, "call_once returned");
    } catch (const std::runtime_error&) {
    }
    std::call_once(flag, once_body, false);
    check(once_calls == 2, "call_once retries after an exception");

    if (failures) return 1;
    std::puts("PASS cpp_throw_test");
    return 0;
}
