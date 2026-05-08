// Regression test for C++ exception unwinding under the wasm-posix-kernel.
//
// Runs three sub-tests:
//   1. throw int caught by typed catch
//   2. throw int caught by catch-all
//   3. throw across one frame of stack
//
// Each sub-test prints PASS or FAIL; the program returns 0 only if all
// three print PASS. fflush(stdout) before each potentially-hanging throw
// so partial output survives a hang and reveals which sub-test wedged.
//
// This test is the regression gate for libunwind being bundled into
// libc++abi.a. With LIBCXXABI_USE_LLVM_UNWINDER=OFF (the pre-fix state),
// _Unwind_RaiseException is left as an undefined import and any throw
// hangs the process indefinitely. With the unwinder bundled in, all
// three sub-tests should print PASS and the program exits 0.

#include <cstdio>
#include <cstdlib>

static void thrower(int x) { throw x; }

int main() {
    int passes = 0;

    fflush(stdout);
    try { throw 42; } catch (int e) {
        if (e == 42) { printf("PASS: typed catch\n"); ++passes; }
        else         { printf("FAIL: typed catch wrong value %d\n", e); }
    }

    fflush(stdout);
    try { throw 7; } catch (...) {
        printf("PASS: catch-all\n"); ++passes;
    }

    fflush(stdout);
    try { thrower(99); } catch (int e) {
        if (e == 99) { printf("PASS: cross-frame\n"); ++passes; }
        else         { printf("FAIL: cross-frame wrong value %d\n", e); }
    }

    fflush(stdout);
    return (passes == 3) ? 0 : 1;
}
