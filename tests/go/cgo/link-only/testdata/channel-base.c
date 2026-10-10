#include <stdint.h>

__asm__(".globaltype __channel_base, i32\n");

int channel_base_ready(int value) {
    uintptr_t base;
    __asm__ volatile("global.get __channel_base\n"
                     "local.set %0" : "=r"(base));
    return base ? value + 1 : 0;
}
