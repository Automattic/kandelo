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

//go:noinline
func deepCallback(depth int) int {
	var frame [256]byte
	frame[0] = byte(depth)
	if depth == 0 {
		return int(frame[0])
	}
	return int(frame[0]) + deepCallback(depth-1)
}

//export go_deep
func go_deep(value C.int) C.int {
	return C.int(deepCallback(int(value)))
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
	if C.call_go_deep_on_pthread() != 128*129/2 {
		panic("C pthread callback stack growth failed")
	}
	fmt.Println("CGO CALLBACK PASS")
}
