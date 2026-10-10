#include <stdint.h>

#include "constructors.h"

extern uint32_t __kandelo_cgo_ctor_count;
extern void __funcs_on_exit(void);

static volatile int value;

__attribute__((constructor(300))) static void second(void) {
    value = value * 10 + 2;
}

__attribute__((constructor(200))) static void first(void) {
    value = value * 10 + 1;
}

__attribute__((destructor)) static void finish(void) {
    value = value * 10 + 3;
}

unsigned int constructor_count(void) {
    return __kandelo_cgo_ctor_count;
}

int constructor_value(void) {
    return value;
}

int run_destructors(void) {
    __funcs_on_exit();
    return value;
}
