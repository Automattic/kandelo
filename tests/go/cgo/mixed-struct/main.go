package main

/*
#include <stdint.h>

static int target = 37;

struct mixed {
    uint32_t first;
    int *pointer;
    int *pointers[2];
    uint32_t last;
};

static struct mixed make_mixed(void) {
    struct mixed value = {11, &target, {&target, &target}, 29};
    return value;
}

static int *target_address(void) { return &target; }

static int check_mixed(struct mixed value) {
    return value.first == 11 && value.pointer == &target &&
        value.pointers[0] == &target && value.pointers[1] == &target &&
        value.last == 29;
}

static void callback(void) {}

struct nested {
    uint64_t wide;
    int *pointer;
    double ratio;
};

struct aggregate {
    uint32_t tag;
    struct nested nested;
    void (*callback)(void);
    uint16_t tail;
};

static struct aggregate make_aggregate(void) {
    struct aggregate value = {7, {0x1122334455667788ULL, &target, 2.5}, callback, 19};
    return value;
}

static int check_aggregate(struct aggregate value) {
    return value.tag == 7 && value.nested.wide == 0x1122334455667788ULL &&
        value.nested.pointer == &target && value.nested.ratio == 2.5 &&
        value.callback == callback && value.tail == 19;
}
*/
import "C"

import (
	"fmt"
	"unsafe"
)

func main() {
	value := C.make_mixed()
	if got := unsafe.Sizeof(value); got != uintptr(C.sizeof_struct_mixed) {
		panic(fmt.Sprintf("C struct size changed: %d", got))
	}
	if unsafe.Offsetof(value.pointer) != 4 || unsafe.Offsetof(value.pointers) != 8 || unsafe.Offsetof(value.last) != 16 {
		panic("C pointer-bearing struct offsets changed")
	}
	target := uintptr(unsafe.Pointer(C.target_address()))
	if value.first != 11 || value.last != 29 || uintptr(value.pointer) != target ||
		uintptr(value.pointers[0]) != target || uintptr(value.pointers[1]) != target {
		panic(fmt.Sprintf("C pointer-bearing struct fields failed: first=%d last=%d pointer=%x", value.first, value.last, value.pointer))
	}
	if C.check_mixed(value) != 1 {
		panic("C by-value struct argument failed")
	}
	aggregate := C.make_aggregate()
	if unsafe.Sizeof(aggregate) != uintptr(C.sizeof_struct_aggregate) ||
		unsafe.Offsetof(aggregate.nested) != 8 || unsafe.Offsetof(aggregate.callback) != 32 ||
		unsafe.Offsetof(aggregate.tail) != 36 || unsafe.Offsetof(aggregate.nested.pointer) != 8 {
		panic("C nested aggregate layout changed")
	}
	if aggregate.tag != 7 || aggregate.nested.wide != 0x1122334455667788 ||
		uintptr(aggregate.nested.pointer) != target || aggregate.nested.ratio != 2.5 ||
		aggregate.tail != 19 || C.check_aggregate(aggregate) != 1 {
		panic("C nested aggregate return or by-value argument failed")
	}
	fmt.Println("CGO MIXED STRUCT PASS")
}
