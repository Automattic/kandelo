package main

/*
#include <stdlib.h>
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
static int add_three(int first, int second, int third) { return first + second + third; }
static int add_pointed(const int *value, int extra) { return *value + extra; }
static int add_middle_pointer(int first, const int *value, int last) { return first + *value + last; }
static uintptr_t thread_identity(void) { return (uintptr_t)pthread_self(); }
static int set_thread_errno(int value) { errno = value; return errno; }
static int get_thread_errno(void) { return errno; }
static const char *probe_env(void) { return getenv("KANDELO_CGO_PROBE"); }
*/
import "C"

import (
	"fmt"
	"os"
	"runtime"
)

func main() {
	if got := C.probe_env(); got == nil || C.GoString(got) != "cgo-startup" {
		panic("C environment initialization failed")
	}
	if err := os.Setenv("KANDELO_CGO_PROBE", "cgo-updated"); err != nil {
		panic(err)
	}
	if got := C.probe_env(); got == nil || C.GoString(got) != "cgo-updated" {
		panic("C environment update failed")
	}
	if err := os.Unsetenv("KANDELO_CGO_PROBE"); err != nil {
		panic(err)
	}
	if C.probe_env() != nil {
		panic("C environment unset failed")
	}
	runtime.GC()
	if result := C.abs(-7); result != 7 {
		panic(fmt.Sprintf("C call failed: got %d", result))
	}
	if result := C.add_three(2, 3, 4); result != 9 {
		panic(fmt.Sprintf("C scalar arguments failed: got %d", result))
	}
	value := C.int(5)
	if result := C.add_pointed(&value, 6); result != 11 {
		panic(fmt.Sprintf("C pointer argument failed: got %d", result))
	}
	if result := C.add_middle_pointer(2, &value, 6); result != 13 {
		panic(fmt.Sprintf("C middle pointer argument failed: got %d", result))
	}
	runtime.GOMAXPROCS(2)
	runtime.LockOSThread()
	mainThread := C.thread_identity()
	if mainThread == 0 || C.set_thread_errno(71) != 71 {
		panic("main M musl thread state failed")
	}
	type threadResult struct {
		value    C.int
		identity C.uintptr_t
		errno    C.int
	}
	for round := 0; round < 4; round++ {
		result := make(chan threadResult, 1)
		go func() {
			runtime.LockOSThread()
			value := C.abs(-11)
			result <- threadResult{value, C.thread_identity(), C.set_thread_errno(C.int(72 + round))}
		}()
		got := <-result
		if got.value != 11 || got.identity == 0 || got.identity == mainThread || got.errno != C.int(72+round) || C.get_thread_errno() != 71 {
			panic(fmt.Sprintf("C call on second M failed: %+v", got))
		}
	}
	fmt.Println("CGO ABS PASS")
}
