#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <time.h>

#define WASM_PAGE_SIZE 65536u
#define GROW_STEPS 128

static _Atomic int grower_ready;
static _Atomic int start_growth;
static _Atomic int first_growth_done;
static _Atomic int reader_ready;
static _Atomic int growth_done;
static _Atomic int observed;
static uintptr_t target_addr;

static void sleep_one_millisecond(void)
{
    const struct timespec duration = { .tv_sec = 0, .tv_nsec = 1000000 };
    nanosleep(&duration, NULL);
}

static void *grower(void *unused)
{
    (void)unused;
    atomic_store_explicit(&grower_ready, 1, memory_order_release);
    __builtin_wasm_memory_atomic_notify((int32_t *)&grower_ready, 1);
    while (!atomic_load_explicit(&start_growth, memory_order_acquire)) {
        __builtin_wasm_memory_atomic_wait32(
            (int32_t *)&start_growth, 0, -1);
    }

    size_t final_page = 0;
    for (int index = 0; index < GROW_STEPS; index++) {
        size_t old_pages = __builtin_wasm_memory_grow(0, 1);
        if (old_pages == (size_t)-1) return (void *)(uintptr_t)1;
        final_page = old_pages;

        if (index == 0) {
            /*
             * WHY: straddle pthread creation deterministically. Main creates
             * the reader only after this first grow, and the remaining grows
             * wait until that reader is running. This avoids claiming timing
             * coverage based only on scheduler luck.
             */
            atomic_store_explicit(
                &first_growth_done, 1, memory_order_release);
            __builtin_wasm_memory_atomic_notify(
                (int32_t *)&first_growth_done, 1);
            while (!atomic_load_explicit(
                &reader_ready, memory_order_acquire)) {
                __builtin_wasm_memory_atomic_wait32(
                    (int32_t *)&reader_ready, 0, -1);
            }
        }
        if ((index & 3) == 3) sleep_one_millisecond();
    }
    target_addr = final_page * WASM_PAGE_SIZE + 123;
    *(volatile unsigned char *)(uintptr_t)target_addr = 0x5a;
    atomic_store_explicit(&growth_done, 1, memory_order_release);
    __builtin_wasm_memory_atomic_notify((int32_t *)&growth_done, 1);
    return NULL;
}

static void *late_reader(void *unused)
{
    (void)unused;
    atomic_store_explicit(&reader_ready, 1, memory_order_release);
    __builtin_wasm_memory_atomic_notify((int32_t *)&reader_ready, 1);
    while (!atomic_load_explicit(&growth_done, memory_order_acquire)) {
        __builtin_wasm_memory_atomic_wait32(
            (int32_t *)&growth_done, 0, -1);
    }
    volatile unsigned char *target =
        (volatile unsigned char *)(uintptr_t)target_addr;
    atomic_store_explicit(&observed, *target, memory_order_release);
    return NULL;
}

int main(void)
{
    pthread_t growing_thread;
    pthread_t reader_thread;
    void *grower_result = NULL;

    if (pthread_create(&growing_thread, NULL, grower, NULL) != 0) return 1;
    while (!atomic_load_explicit(&grower_ready, memory_order_acquire)) {
        __builtin_wasm_memory_atomic_wait32(
            (int32_t *)&grower_ready, 0, -1);
    }

    atomic_store_explicit(&start_growth, 1, memory_order_release);
    __builtin_wasm_memory_atomic_notify((int32_t *)&start_growth, 1);
    while (!atomic_load_explicit(&first_growth_done, memory_order_acquire)) {
        __builtin_wasm_memory_atomic_wait32(
            (int32_t *)&first_growth_done, 0, -1);
    }
    if (pthread_create(&reader_thread, NULL, late_reader, NULL) != 0) return 2;

    if (pthread_join(growing_thread, &grower_result) != 0) return 3;
    if (grower_result != NULL) return 4;
    if (pthread_join(reader_thread, NULL) != 0) return 5;
    if (atomic_load_explicit(&observed, memory_order_acquire) != 0x5a) return 6;
    puts("PASS pthread growth across creation");
    return 0;
}
