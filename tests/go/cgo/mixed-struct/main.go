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
	fmt.Println("CGO MIXED STRUCT PASS")
}
