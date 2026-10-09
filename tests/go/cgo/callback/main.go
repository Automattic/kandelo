package main

/*
#include "callback.h"
*/
import "C"

//export go_double
func go_double(value C.int) C.int {
	return value * 2
}

func main() {
	if C.call_go(7) != 14 {
		panic("C-to-Go callback failed")
	}
	if C.call_go_on_pthread(11) != 22 {
		panic("C pthread callback failed")
	}
}
