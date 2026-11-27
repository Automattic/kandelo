/*
 * Adapted from musl src/exit/atexit.c. Preserve its reverse registration
 * order and lock while allowing a side image to drain its own callbacks.
 */
#include <stdlib.h>
#include <stdint.h>
#include "libc.h"
#include "lock.h"
#include "fork_impl.h"

#define COUNT 32

static struct callbacks {
    struct callbacks *next;
    void (*function[COUNT])(void *);
    void *argument[COUNT];
    void *dso[COUNT];
} builtin, *head;

static int slot;
static volatile int lock[1];
volatile int *const __atexit_lockptr = lock;

void __cxa_finalize(void *dso)
{
    for (;;) {
        LOCK(lock);
        struct callbacks *block = head;
        int index = slot;
        while (block) {
            while (index > 0) {
                --index;
                if (block->function[index] && (!dso || block->dso[index] == dso))
                    goto run;
            }
            block = block->next;
            index = COUNT;
        }
        UNLOCK(lock);
        return;
    run:;
        void (*function)(void *) = block->function[index];
        void *argument = block->argument[index];
        block->function[index] = 0;
        while (head) {
            while (slot > 0 && !head->function[slot - 1]) --slot;
            if (slot > 0 || head == &builtin) break;
            struct callbacks *empty = head;
            head = head->next;
            slot = COUNT;
            __libc_free(empty);
        }
        UNLOCK(lock);
        function(argument);
    }
}

void __funcs_on_exit(void)
{
    __cxa_finalize(0);
}

int __cxa_atexit(void (*function)(void *), void *argument, void *dso)
{
    LOCK(lock);

    if (!head) head = &builtin;
    if (slot == COUNT) {
        struct callbacks *new_head = __libc_calloc(1, sizeof(*new_head));
        if (!new_head) {
            UNLOCK(lock);
            return -1;
        }
        new_head->next = head;
        head = new_head;
        slot = 0;
    }
    head->function[slot] = function;
    head->argument[slot] = argument;
    head->dso[slot] = dso;
    ++slot;

    UNLOCK(lock);
    return 0;
}

static void call(void *function)
{
    ((void (*)(void))(uintptr_t)function)();
}

int atexit(void (*function)(void))
{
    return __cxa_atexit(call, (void *)(uintptr_t)function, 0);
}
