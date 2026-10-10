#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>

#include "constructors.h"

extern uint32_t __kandelo_cgo_ctor_count;
extern void __funcs_on_exit(void);

static volatile int value;
static int report_exit;

static void earliest(void) {
    value = value * 10 + 9;
}

__attribute__((used, section(".init_array.150")))
static void (*const earliest_entry)(void) = earliest;

__attribute__((constructor(300))) static void second(void) {
    value = value * 10 + 2;
}

__attribute__((constructor(200))) static void first(void) {
    value = value * 10 + 1;
}

__attribute__((destructor)) static void finish(void) {
    value = value * 10 + 3;
    if (report_exit) {
        static const char message[] = "CGO C EXIT HANDLER PASS\n";
        write(1, message, sizeof(message) - 1);
    }
}

void request_c_exit(void) {
    report_exit = 1;
    exit(0);
}

void request_c_immediate_exit(void) {
    static const char message[] = "CGO C _EXIT PASS\n";
    report_exit = 1;
    write(1, message, sizeof(message) - 1);
    _exit(0);
}

void expect_no_exit_handler(void) {
    report_exit = 1;
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
