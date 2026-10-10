package main

/*
#include "callback.h"
#include <stdlib.h>
*/
import "C"

import (
	"fmt"
	"runtime"
	"time"
)

//export go_double
func go_double(value C.int) C.int {
	if C.abs(-value) != value {
		panic("nested C call in callback failed")
	}
	runtime.Gosched()
	time.Sleep(time.Millisecond)
	if C.abs(-value) != value {
		panic("nested C call after callback resume failed")
	}
	return value * 2
}

//export go_message
func go_message(value C.int) *C.char {
	if value != 7 {
		panic("unexpected callback argument")
	}
	return C.CString("callback-7")
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
	if C.call_go_message_on_pthread() != 1 {
		panic("C pointer result from Go callback failed")
	}
	fmt.Println("CGO CALLBACK PASS")
}
