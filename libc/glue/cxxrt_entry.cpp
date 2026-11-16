/* cxxrt_entry.cpp — std::terminate for C++ exceptions no handler catches.
 *
 * A C++ exception that no handler catches must call std::terminate
 * ([except.handle]), whose default handler prints "terminating due to
 * uncaught exception of type ..." and calls abort(), so the process ends by
 * SIGABRT. On a native target the unwinder's search phase finds that no
 * handler exists before it unwinds anything, and __cxa_throw calls
 * std::terminate itself. WebAssembly exception handling has no search
 * phase: an exception that nothing catches leaves the program's Wasm stack
 * and reaches the host instead.
 *
 * So the SDK links this object into every executable that links the C++
 * runtime (libc++abi). Its strong definitions replace libc's weak
 * language-runtime entries, one at the bottom of every guest stack: the main
 * thread's (libc/musl-overlay/src/env/__libc_start_main.c) and each thread's
 * (the pthread_create.c patch in scripts/build-musl.sh). Each runs the libc
 * body inside a catch handler that calls std::terminate with the exception
 * caught, so the terminate handler can name it (std::current_exception).
 * The standard leaves it implementation-defined whether the stack is
 * unwound before std::terminate is called; here it is, so destructors of
 * the frames the exception left have run.
 *
 * `catch (...)` compiles to a catch of the C++ exception tag only. Other
 * exceptions, such as longjmp's and fork instrumentation's private unwind,
 * pass through unchanged.
 *
 * The C++ runtime functions are weak references. A program that can throw a
 * C++ exception links __cxa_throw, which brings in both of them; one that
 * cannot does not grow by the terminate handler and demangler for a handler
 * that never runs. The thread bodies are weak for the same reason: they are
 * linked only by a program that creates threads.
 */

extern "C" {
[[noreturn]] void __kandelo_run_main(int (*)(int, char **), int, char **);
[[noreturn]] void __kandelo_run_pthread(void *(*)(void *), void *)
    __attribute__((weak));
[[noreturn]] void __kandelo_run_thrd(int (*)(void *), void *)
    __attribute__((weak));
}

namespace std {
[[noreturn]] void terminate() noexcept __attribute__((weak));
}

/* The compiler emits the __cxa_begin_catch call of a catch handler itself,
 * so a declaration's weak attribute does not reach that reference. Mark the
 * symbol weak in the object file instead. */
__asm__(".weak __cxa_begin_catch");

extern "C" [[noreturn]] void __kandelo_main_entry(
    int (*main)(int, char **), int argc, char **argv) {
  try {
    __kandelo_run_main(main, argc, argv);
  } catch (...) {
    std::terminate();
  }
}

extern "C" [[noreturn]] void __kandelo_pthread_entry(
    void *(*start)(void *), void *arg) {
  try {
    __kandelo_run_pthread(start, arg);
  } catch (...) {
    std::terminate();
  }
}

extern "C" [[noreturn]] void __kandelo_thrd_entry(
    int (*start)(void *), void *arg) {
  try {
    __kandelo_run_thrd(start, arg);
  } catch (...) {
    std::terminate();
  }
}
