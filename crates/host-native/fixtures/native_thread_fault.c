/*
 * A pthread that faults, and a parent that reaps the process it killed.
 *
 * POSIX: a fault is a synchronous signal delivered to the faulting thread,
 * and the default action of SIGSEGV or SIGILL terminates the whole PROCESS,
 * not just that thread; a parent's wait status then reports the signal
 * (WIFSIGNALED, WTERMSIG). A Wasm trap cannot be resumed, so on every Kandelo
 * host the fault takes that default action. The tests using this fixture
 * (`smoke_pthread_fault_*` in ../src/lib.rs) check that host-native does what
 * the Node and browser hosts do: the whole process dies promptly, with the
 * fault's signal, instead of the main thread parking in pthread_join() until
 * the pump's 30-second cap.
 *
 *   native_thread_fault overflow      a pthread recurses past the guest's
 *                                     Wasm stack (SIGSEGV)
 *   native_thread_fault unreachable   a pthread executes Wasm `unreachable`
 *                                     (SIGILL)
 *   native_thread_fault exit          a pthread calls exit(3): not a fault,
 *                                     but the request that used to trap the
 *                                     kernel (`exit_group` on a pthread's own
 *                                     channel), and the same whole-process
 *                                     end (WIFEXITED, status 3)
 *   native_thread_fault spawn MODE    posix_spawn /bin/fault MODE (this same
 *                                     program), reap it, and print how it
 *                                     ended: "signaled=N" or "exited=N"
 *
 * The recursion uses no address-taken locals, so it consumes only the engine
 * stack, never the guest's shadow stack in linear memory; see
 * native_stack_depth.c.
 *
 * Built through the SDK like the other fixtures; see fixtures/README.md.
 */
#include <pthread.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

__attribute__((noinline))
static unsigned recurse(unsigned depth) {
    if (depth == 0) return 0;
    unsigned reached = recurse(depth - 1);
    // WHY: keep each activation live across the call, so the compiler cannot
    // turn the recursion into a loop.
    __asm__ volatile("" : "+r"(reached));
    return reached + 1;
}

static void say(const char *line) {
    write(1, line, strlen(line));
}

static void *fault(void *arg) {
    const char *mode = arg;
    say("thread running\n");
    if (strcmp(mode, "overflow") == 0) {
        // Far more than the guest's 8 MiB Wasm stack holds.
        unsigned reached = recurse(100000000u);
        char line[48];
        int n = snprintf(line, sizeof(line), "DEPTH_REACHED %u\n", reached);
        if (n > 0) write(1, line, (size_t)n);
    } else if (strcmp(mode, "unreachable") == 0) {
        __builtin_trap();
    } else if (strcmp(mode, "exit") == 0) {
        exit(3);
    }
    return NULL;
}

static int reap_spawned(const char *mode) {
    char *child_argv[] = { "/bin/fault", (char *)mode, NULL };
    pid_t pid = 0;
    int rc = posix_spawn(&pid, "/bin/fault", NULL, NULL, child_argv, environ);
    if (rc != 0) {
        say("FAIL: posix_spawn\n");
        return 1;
    }
    int status = 0;
    if (waitpid(pid, &status, 0) != pid) {
        say("FAIL: waitpid\n");
        return 1;
    }
    char line[32];
    int n = WIFSIGNALED(status)
        ? snprintf(line, sizeof(line), "signaled=%d\n", WTERMSIG(status))
        : snprintf(line, sizeof(line), "exited=%d\n", WEXITSTATUS(status));
    if (n > 0) write(1, line, (size_t)n);
    return 0;
}

int main(int argc, char **argv) {
    if (argc >= 3 && strcmp(argv[1], "spawn") == 0) {
        return reap_spawned(argv[2]);
    }
    if (argc < 2) {
        say("usage: native_thread_fault overflow|unreachable|exit|spawn MODE\n");
        return 2;
    }
    pthread_t thread;
    if (pthread_create(&thread, NULL, fault, argv[1]) != 0) {
        say("FAIL: pthread_create\n");
        return 1;
    }
    // The fault must end the process while this thread is parked here.
    pthread_join(thread, NULL);
    say("FAIL: joined a thread that faulted\n");
    return 1;
}
