#include "continuation.h"

#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

enum { STACK_SIZE = 128 * 1024, ROUNDS = 32 };
static _Thread_local unsigned tls_value;

struct test_case {
    unsigned result;
    const volatile unsigned *stack_root;
    pthread_t thread;
    struct kandelo_continuation *nested;
    bool fork_inside;
    bool found_stack_root;
};

__attribute__((noinline))
static void pause_with_stack_root(struct test_case *test, unsigned iteration)
{
    volatile unsigned on_stack = iteration + 100;
    test->stack_root = &on_stack;
    kandelo_continuation_suspend();
    assert(on_stack == iteration + 100);
    assert(pthread_equal(test->thread, pthread_self()));
    assert(tls_value == iteration + 1);
    test->result++;
}

static void collect_range(void *address, size_t bytes, void *argument)
{
    struct test_case *test = argument;
    uintptr_t root = (uintptr_t)test->stack_root;
    uintptr_t start = (uintptr_t)address;
    if (root >= start && root - start < bytes) {
        assert(*test->stack_root == test->result + 100);
        test->found_stack_root = true;
    }
}

static void wait_success(pid_t child)
{
    int status;
    assert(waitpid(child, &status, 0) == child);
    assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
}

static void run(void *argument)
{
    struct test_case *test = argument;
    test->thread = pthread_self();
    if (test->nested)
        assert(kandelo_continuation_enter(test->nested) == 1);

    for (unsigned iteration = 0; iteration < ROUNDS; iteration++) {
        tls_value = iteration;
        pause_with_stack_root(test, iteration);
    }
    if (test->nested) {
        tls_value = 1;
        assert(kandelo_continuation_enter(test->nested) == 1);
    }
    if (test->fork_inside) {
        pid_t child = fork();
        assert(child >= 0);
        if (!child)
            _exit(test->result == ROUNDS ? 0 : 1);
        wait_success(child);
    }
}

static struct kandelo_continuation *make(void **stack, struct test_case *test)
{
    *stack = malloc(STACK_SIZE);
    assert(*stack);
    struct kandelo_continuation *ctx =
        kandelo_continuation_create(*stack, (char *)*stack + STACK_SIZE, run, test);
    assert(ctx);
    return ctx;
}

static void drive(struct kandelo_continuation *ctx, struct test_case *test)
{
    for (unsigned iteration = test->result; iteration < ROUNDS; iteration++) {
        tls_value = iteration + 1;
        assert(kandelo_continuation_enter(ctx) == (iteration + 1 == ROUNDS ? 0 : 1));
        assert(test->result == iteration + 1);
        if (iteration + 1 < ROUNDS) {
            test->found_stack_root = false;
            kandelo_continuation_visit_saved(ctx, collect_range, test);
            assert(test->found_stack_root);
        }
    }
}

static void *worker(void *argument)
{
    struct kandelo_continuation *main_context = argument;
    errno = 0;
    assert(kandelo_continuation_enter(main_context) == -1 && errno == EXDEV);

    struct test_case nested = {0};
    void *nested_stack;
    struct test_case test = {.nested = make(&nested_stack, &nested)};
    void *stack;
    struct kandelo_continuation *ctx = make(&stack, &test);
    assert(kandelo_continuation_enter(ctx) == 1);
    drive(ctx, &test);
    assert(nested.result == 1);
    assert(kandelo_continuation_destroy(test.nested) == 0);
    assert(kandelo_continuation_destroy(ctx) == 0);
    free(nested_stack);
    free(stack);
    return NULL;
}

int main(void)
{
    struct test_case test = {.fork_inside = true};
    void *stack;
    struct kandelo_continuation *ctx = make(&stack, &test);
    assert(kandelo_continuation_enter(ctx) == 1);

    pthread_t thread;
    assert(pthread_create(&thread, NULL, worker, ctx) == 0);
    assert(pthread_join(thread, NULL) == 0);

    pid_t child = fork();
    assert(child >= 0);
    if (!child) {
        test.fork_inside = false;
        drive(ctx, &test);
        _exit(kandelo_continuation_destroy(ctx) == 0 ? 0 : 1);
    }
    wait_success(child);
    drive(ctx, &test);
    assert(kandelo_continuation_destroy(ctx) == 0);
    free(stack);
    puts("compiled continuations ok");
    return 0;
}
