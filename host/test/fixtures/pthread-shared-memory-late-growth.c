#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>

#define WASM_PAGE_SIZE 65536u

static _Atomic int phase;
static _Atomic int observed;
static uintptr_t target_addr;

static void *reader(void *unused)
{
    (void)unused;

    /*
     * WHY: tell main that this pthread is already running before main grows
     * memory. The final read therefore checks a later growth notification,
     * rather than merely checking the memory size inherited at startup.
     */
    atomic_store_explicit(&phase, 1, memory_order_release);
    __builtin_wasm_memory_atomic_notify((int32_t *)&phase, 1);

    while (atomic_load_explicit(&phase, memory_order_acquire) != 2) {
        __builtin_wasm_memory_atomic_wait32((int32_t *)&phase, 1, -1);
    }

    volatile unsigned char *target =
        (volatile unsigned char *)(uintptr_t)target_addr;
    atomic_store_explicit(&observed, *target, memory_order_release);
    return NULL;
}

int main(void)
{
    pthread_t thread;
    if (pthread_create(&thread, NULL, reader, NULL) != 0) {
        fputs("pthread_create failed\n", stderr);
        return 1;
    }

    while (atomic_load_explicit(&phase, memory_order_acquire) != 1) {
        __builtin_wasm_memory_atomic_wait32((int32_t *)&phase, 0, -1);
    }

    size_t old_pages = __builtin_wasm_memory_size(0);
    size_t grown_from = __builtin_wasm_memory_grow(0, 8);
    if (grown_from == (size_t)-1 || grown_from != old_pages) {
        fputs("memory.grow failed\n", stderr);
        return 2;
    }

    target_addr = (old_pages + 7) * WASM_PAGE_SIZE + 123;
    *(volatile unsigned char *)(uintptr_t)target_addr = 0x5a;
    atomic_store_explicit(&phase, 2, memory_order_release);
    __builtin_wasm_memory_atomic_notify((int32_t *)&phase, 1);

    if (pthread_join(thread, NULL) != 0) {
        fputs("pthread_join failed\n", stderr);
        return 3;
    }
    if (atomic_load_explicit(&observed, memory_order_acquire) != 0x5a) {
        fputs("thread did not observe the grown page\n", stderr);
        return 4;
    }
    puts("PASS late pthread memory growth");
    return 0;
}
