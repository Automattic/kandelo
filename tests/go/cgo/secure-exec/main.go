package main

/*
#define _GNU_SOURCE
#include <stdlib.h>
#include <unistd.h>
#include <sys/auxv.h>
*/
import "C"

import (
	"fmt"
	"os"
	"unsafe"
)

func main() {
	if len(os.Args) < 3 {
		panic("missing secure-startup expectation")
	}
	expectedSecure := os.Args[2] == "1"
	variable := C.CString("KANDELO_UNTRUSTED")
	defer C.free(unsafe.Pointer(variable))
	secure := C.issetugid() != 0
	auxSecure := C.getauxval(C.AT_SECURE) != 0
	visible := C.secure_getenv(variable) != nil
	if secure != expectedSecure || auxSecure != expectedSecure || visible == expectedSecure {
		panic(fmt.Sprintf("secure=%t aux=%t visible=%t expected=%t", secure, auxSecure, visible, expectedSecure))
	}
	fmt.Printf("GO CGO SECURE EXEC PASS secure=%t\n", secure)
}
