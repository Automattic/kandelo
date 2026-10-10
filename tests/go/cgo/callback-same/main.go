package main

/*
#include <stdlib.h>
extern int go_double(int value);
static int call_go(int value) { return go_double(value); }
*/
import "C"

import (
	"fmt"
	"runtime"
	"time"
)

//export go_double
func go_double(value C.int) C.int {
	runtime.Gosched()
	time.Sleep(time.Millisecond)
	return C.abs(-value) * 2
}

func main() {
	if result := C.call_go(7); result != 14 {
		panic(fmt.Sprintf("C callback failed: got %d", result))
	}
	runtime.GOMAXPROCS(2)
	runtime.LockOSThread()
	result := make(chan C.int, 1)
	go func() {
		runtime.LockOSThread()
		result <- C.call_go(11)
	}()
	if got := <-result; got != 22 {
		panic(fmt.Sprintf("C callback on second M failed: got %d", got))
	}
	fmt.Println("CGO CALLBACK PASS")
}
