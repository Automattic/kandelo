package main

/*
#include "callback.h"
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
	return value * 2
}

func main() {
	if C.call_go(7) != 14 {
		panic("C-to-Go callback failed")
	}
	if C.call_go_on_pthread(11) != 22 {
		panic("C pthread callback failed")
	}
	runtime.GOMAXPROCS(2)
	result := make(chan C.int, 1)
	go func() {
		runtime.LockOSThread()
		result <- C.call_go_on_pthread(13)
	}()
	if <-result != 26 {
		panic("C pthread callback from second Go M failed")
	}
	fmt.Println("CGO CALLBACK PASS")
}
