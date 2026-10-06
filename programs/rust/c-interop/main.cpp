// C++ program linked against the Rust library (rustlib/). Exercises the
// same API from C++, alongside C++ exceptions and the standard library.
#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#include <unistd.h>

#include "kandelo_interop.h"

namespace {

int failures = 0;

void check(bool ok, const std::string &what) {
    std::cout << (ok ? "ok " : "FAIL ") << what << '\n';
    if (!ok) failures++;
}

struct RustString {
    void operator()(char *s) const { interop_free_string(s); }
};

extern "C" int doubled(int x) { return x * 2; }

}  // namespace

int main() {
    check(interop_u128_muldiv(UINT64_MAX, 3, 5) == 11068046444225730969ULL,
          "u128 muldiv");

    std::unique_ptr<char, RustString> greeting(interop_greeting("C++"));
    check(std::string(greeting.get()) == "hello, C++, from Rust", "Rust-owned string");

    check(interop_apply(doubled, 3) == 12, "C++ callback called from Rust");

    errno = 0;
    check(close(-1) == -1 && interop_last_errno() == EBADF, "shared errno");

    // A C++ exception thrown and caught around calls into Rust.
    std::vector<uint64_t> sums;
    try {
        sums.push_back(interop_parallel_sum(2, 10));
        throw std::runtime_error("from C++");
    } catch (const std::exception &e) {
        check(std::string(e.what()) == "from C++" && sums.at(0) == 100,
              "C++ exception around Rust calls");
    }

    std::cout << (failures ? "CPP-CALLS-RUST FAILED" : "CPP-CALLS-RUST OK") << std::endl;
    return failures ? 1 : 0;
}
