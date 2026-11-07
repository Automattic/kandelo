package main

/*
#include <stdint.h>
#include <stdlib.h>
#include <errno.h>
int wasm32_live_function(void);

typedef struct sample {
 uint32_t tag;
 int *value;
 uint64_t wide;
 int **link;
 uint8_t tail;
} sample;
static int stable = 37;
static int *stable_pointer = &stable;
static sample make_sample(void) {
 sample result = {3, &stable, UINT64_C(0x123456789abcdef0), &stable_pointer, 5};
 return result;
}
static int sample_sum(sample value, int extra) {
 return value.tag + *value.value + **value.link + value.tail + extra;
}
static int read_int(const int *value) { return *value; }
static int result_with_errno(int value) { errno = EINVAL; return value + 2; }
static uint64_t framed_wide(uint32_t prefix, uint64_t wide, uint32_t suffix) {
 if (prefix != 3 || suffix != 7) return 0;
 return wide;
}
static double framed_double(uint32_t prefix, double value, uint32_t suffix) {
 if (prefix != 3 || suffix != 7) return -1;
 return value + 0.5;
}
typedef int (*unary)(int);
int plus_seventeen(int value);
static int call_pointer(unary function, int value) { return function(value); }
struct function_holder { unary function; };
static struct function_holder make_function_holder(void) {
 struct function_holder result = { plus_seventeen };
 return result;
}
*/
import "C"

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"
)

//go:noinline
func follow(value **C.int) *C.int { return *value }

//go:noinline
func replace(value **C.int, replacement *C.int) { *value = replacement }

//go:noinline
func growWithFunctionPointer(function C.unary, depth int) int {
	var padding [64]uint64
	padding[depth%len(padding)] = uint64(depth)
	if depth == 0 {
		return int(C.call_pointer(function, 5))
	}
	result := growWithFunctionPointer(function, depth-1)
	runtime.KeepAlive(function)
	runtime.KeepAlive(&padding)
	return result
}

func main() {
	if C.wasm32_live_function() != 29 {
		panic("live C object function failed")
	}
	value, err := C.result_with_errno(7)
	if value != 9 || err != syscall.EINVAL {
		panic(fmt.Sprintf("cgo errno result lost: value=%d errno=%v", value, err))
	}
	if value := C.framed_wide(3, 0x1122334455667788, 7); value != 0x1122334455667788 {
		panic(fmt.Sprintf("64-bit C frame alignment lost: %#x", value))
	}
	if value := C.framed_double(3, 2.5, 7); value != 3 {
		panic(fmt.Sprintf("float64 C frame alignment lost: %v", value))
	}
	var sample C.sample
	if unsafe.Sizeof(sample) != C.sizeof_sample || unsafe.Sizeof(sample.value) != 4 {
		panic("C and Go struct/pointer layouts differ")
	}
	sample = C.make_sample()
	if sample.value == nil || sample.link == nil || *sample.value != 37 || **sample.link != 37 || sample.wide != 0x123456789abcdef0 {
		panic("ordinary typed C struct access failed")
	}
	if C.sample_sum(sample, 7) != 89 {
		panic("pointer-bearing by-value struct call failed")
	}
	if C.call_pointer(C.unary(unsafe.Pointer(C.plus_seventeen)), 5) != 22 {
		panic("C function pointer has wrong table representation")
	}
	functions := C.make_function_holder()
	// Keep a low table handle live in a typed C field and Go stack slot.
	// The old representation aborts with "invalid pointer found on stack".
	if handle := uintptr(unsafe.Pointer(functions.function)); handle == 0 || handle >= 4096 {
		panic("function-pointer regression requires a low nonzero table handle")
	}
	runtime.GC()
	if growWithFunctionPointer(functions.function, 256) != 22 {
		panic("C function pointer was lost during Go stack growth")
	}
	runtime.KeepAlive(functions)
	rooted := new(C.sample)
	rooted.value = new(C.int)
	*rooted.value = 41
	escaped := &rooted.value
	rooted = nil
	runtime.GC() // Root/alias semantics, not memory reclamation.
	if *follow(escaped) != 41 {
		panic("typed C field lost its Go GC root")
	}
	next := new(C.int)
	*next = 43
	replace(escaped, next)
	next = nil
	runtime.GC()
	if *follow(escaped) != 43 || C.read_int(follow(escaped)) != 43 {
		panic("escaping typed pointer field lost write-through")
	}
	runtime.KeepAlive(escaped)
	fmt.Println("WASM32 TYPED CGO PASS")
}
