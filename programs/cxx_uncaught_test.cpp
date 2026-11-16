// A C++ exception that no handler catches calls std::terminate
// (host/test/cxx-terminate.test.ts).
//
// [except.handle]: when no handler matches, std::terminate is called. Its
// default handler (libc++abi's) prints "terminating due to uncaught
// exception of type <type>: <what()>" and calls abort(), so the process ends
// by SIGABRT. WebAssembly exception handling has no search phase, so the
// SDK's C++ runtime entry (libc/glue/cxxrt_entry.cpp) catches such an
// exception at the bottom of each stack and calls std::terminate.
//
// usage: cxx_uncaught_test <mode>
//   main       throw std::runtime_error from main; a local's destructor
//              reports that the stack was unwound first
//   int        throw an int from main
//   ctor       throw from a static object's constructor
//   thread     throw from a std::thread's function
//   pthread    throw from a pthread_create start routine
//   handler    std::set_terminate handler runs, then _exit(3)
//   caught     a handled exception does not terminate (exit 0)
//   waitpid    a forked child throws; the parent reports how waitpid saw it
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <pthread.h>
#include <stdexcept>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>

static const char* mode = "";

struct Unwound {
    ~Unwound() { std::printf("unwound main\n"); std::fflush(stdout); }
};

struct ThrowsOnConstruction {
    ThrowsOnConstruction() {
        if (std::strcmp(mode, "ctor") == 0) throw std::logic_error("static constructor");
    }
};

// Constructed by the program's constructors, before main. The mode comes
// from the environment because argv is not yet available.
static const char* mode_from_environment() {
    const char* value = std::getenv("CXX_UNCAUGHT_MODE");
    return value ? value : "";
}
static struct SetMode {
    SetMode() { mode = mode_from_environment(); }
} set_mode;
static ThrowsOnConstruction throws_on_construction;

__attribute__((noinline)) static void throw_runtime_error(const char* what) {
    throw std::runtime_error(what);
}

static void* pthread_start(void*) {
    throw_runtime_error("pthread start routine");
    return nullptr;
}

static void terminate_handler() {
    std::printf("terminate handler ran\n");
    std::fflush(stdout);
    std::exception_ptr current = std::current_exception();
    try {
        if (current) std::rethrow_exception(current);
        std::printf("no current exception\n");
    } catch (const std::exception& e) {
        std::printf("current exception: %s\n", e.what());
    }
    std::fflush(stdout);
    _exit(3);
}

int main(int argc, char** argv) {
    if (argc > 1) mode = argv[1];

    if (std::strcmp(mode, "main") == 0) {
        Unwound unwound;
        throw_runtime_error("thrown from main");
    }
    if (std::strcmp(mode, "int") == 0) {
        throw 42;
    }
    if (std::strcmp(mode, "thread") == 0) {
        std::thread thread([] { throw_runtime_error("std::thread function"); });
        thread.join();
        return 0;
    }
    if (std::strcmp(mode, "pthread") == 0) {
        pthread_t thread;
        if (pthread_create(&thread, nullptr, pthread_start, nullptr) != 0) return 2;
        pthread_join(thread, nullptr);
        return 0;
    }
    if (std::strcmp(mode, "handler") == 0) {
        std::set_terminate(terminate_handler);
        throw_runtime_error("handled by set_terminate");
    }
    if (std::strcmp(mode, "caught") == 0) {
        try {
            throw_runtime_error("caught");
        } catch (const std::runtime_error& e) {
            std::printf("caught: %s\n", e.what());
        }
        return 0;
    }
    if (std::strcmp(mode, "waitpid") == 0) {
        std::fflush(stdout);
        pid_t child = fork();
        if (child < 0) return 2;
        if (child == 0) throw_runtime_error("thrown in a forked child");
        int status = 0;
        if (waitpid(child, &status, 0) != child) return 2;
        if (WIFSIGNALED(status)) {
            std::printf("child signaled %d%s\n", WTERMSIG(status),
                        WTERMSIG(status) == SIGABRT ? " (SIGABRT)" : "");
        } else if (WIFEXITED(status)) {
            std::printf("child exited %d\n", WEXITSTATUS(status));
        }
        return WIFSIGNALED(status) && WTERMSIG(status) == SIGABRT ? 0 : 1;
    }
    std::fprintf(stderr, "usage: cxx_uncaught_test <mode>\n");
    return 2;
}
