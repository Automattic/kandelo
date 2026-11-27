#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

#define PAGE 65536
#define CHECK(e) do { if (!(e)) { fprintf(stderr, "FAIL line=%d errno=%d: %s\n", __LINE__, errno, #e); _Exit(1); } } while (0)

int main(void) {
    int *barrier = mmap(NULL, PAGE, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
    CHECK(barrier != MAP_FAILED);
    pid_t children[3];
    for (int child = 0; child < 3; child++) {
        children[child] = fork();
        CHECK(children[child] >= 0);
        if (children[child] == 0) {
            __atomic_fetch_add(&barrier[0], 1, __ATOMIC_SEQ_CST);
            while (!__atomic_load_n(&barrier[1], __ATOMIC_SEQ_CST)) sched_yield();
            for (int cycle = 0; cycle < 128; cycle++) {
                uint32_t first = __builtin_wasm_memory_grow(0, 4);
                CHECK(first != UINT32_MAX);
                volatile uint32_t *words = (void *)(uintptr_t)(first * PAGE);
                uint32_t value = (child + 1) * 100000 + cycle;
                for (int i = 0; i < 4 * PAGE / 4; i++) { CHECK(words[i] == 0); words[i] = value; }
                sched_yield();
                for (int i = 0; i < 4 * PAGE / 4; i++) CHECK(words[i] == value);
                CHECK(munmap((void *)words, 4 * PAGE) == 0);
            }
            _Exit(0);
        }
    }
    while (__atomic_load_n(&barrier[0], __ATOMIC_SEQ_CST) != 3) sched_yield();
    __atomic_store_n(&barrier[1], 1, __ATOMIC_SEQ_CST);
    // mmap and the grouped SDK memory.grow request use the same kernel frame
    // owner. All reuse and retirement goes through real kernel operations.
    for (int cycle = 0; cycle < 512; cycle++) {
        volatile uint32_t *words = mmap(NULL, PAGE, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        CHECK(words != MAP_FAILED);
        for (int i = 0; i < PAGE / 4; i++) CHECK(words[i] == 0);
        words[0] = cycle + 1;
        sched_yield();
        CHECK(words[0] == (uint32_t)cycle + 1);
        CHECK(munmap((void *)words, PAGE) == 0);
    }
    for (int child = 0; child < 3; child++) {
        int status;
        CHECK(waitpid(children[child], &status, 0) == children[child]);
        CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 0);
    }
    CHECK(munmap(barrier, PAGE) == 0);
    puts("grouped-sdk-grow-churn PASS 384 512");
    return 0;
}
