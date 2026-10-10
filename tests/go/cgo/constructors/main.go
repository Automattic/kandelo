package main

/*
#include "constructors.h"
*/
import "C"

import "fmt"

func main() {
	if count := C.constructor_count(); count < 2 {
		panic(fmt.Sprintf("C constructors missing: %d", count))
	}
	if value := C.constructor_value(); value != 12 {
		panic(fmt.Sprintf("C constructor order failed: %d", value))
	}
	if value := C.run_destructors(); value != 123 {
		panic(fmt.Sprintf("C destructor registration failed: %d", value))
	}
	fmt.Println("CGO CONSTRUCTORS PASS")
}
