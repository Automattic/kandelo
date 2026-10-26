/* Real SDK/host regression: two C pointer types share one Wasm signature.
 * The fork child must resume correctly, then longjmp to its inherited buffer.
 * Volatile callback loads keep indirect calls visible after LLVM optimization.
 */
#include <setjmp.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

struct fork_input { int expected; };
struct pure_input { int value; };
static jmp_buf destination;

static int fork_callback(struct fork_input *input) {
    if (setjmp(destination))
        _exit(input->expected == 7 ? 0 : 70);
    pid_t child = fork();
    if (child < 0)
        return 71;
    if (!child)
        longjmp(destination, 1);
    int status;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status))
        return 72;
    return 0;
}

static int pure_callback(struct pure_input *input) { return input->value + 1; }
static int (*volatile fork_target)(struct fork_input *) = fork_callback;
static int (*volatile pure_target)(struct pure_input *) = pure_callback;

static int invoke_fork(int (*callback)(struct fork_input *), struct fork_input *input) {
    return callback(input);
}

static int invoke_pure(int (*callback)(struct pure_input *), struct pure_input *input) {
    return callback(input);
}

int main(void) {
    struct fork_input input = {7};
    struct pure_input pure = {10};
    int status = invoke_fork(fork_target, &input);
    if (status)
        return status;
    if (invoke_pure(pure_target, &pure) != 11)
        return 73;
    puts("DONE");
    return 0;
}
