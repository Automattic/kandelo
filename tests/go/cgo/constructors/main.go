package main

/*
#include "constructors.h"
*/
import "C"

import (
	"fmt"
	"os"
)

func main() {
	if count := C.constructor_count(); count < 3 {
		panic(fmt.Sprintf("C constructors missing: %d", count))
	}
	if value := C.constructor_value(); value != 912 {
		panic(fmt.Sprintf("C constructor order failed: %d", value))
	}
	if len(os.Args) > 1 && os.Args[1] == "c-exit" {
		C.request_c_exit()
		panic("C exit returned")
	}
	if len(os.Args) > 1 && os.Args[1] == "c-immediate-exit" {
		C.request_c_immediate_exit()
		panic("C _exit returned")
	}
	if len(os.Args) > 1 && (os.Args[1] == "go-return" || os.Args[1] == "go-os-exit") {
		C.expect_no_exit_handler()
		fmt.Println("CGO GO EXIT PASS")
		if os.Args[1] == "go-os-exit" {
			os.Exit(0)
		}
		return
	}
	if value := C.run_destructors(); value != 9123 {
		panic(fmt.Sprintf("C destructor registration failed: %d", value))
	}
	fmt.Println("CGO CONSTRUCTORS PASS")
}
