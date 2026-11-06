//go:build kandelo && cgo

package main

/*
#include <stdlib.h>
*/
import "C"

func init() {
	if C.abs(-7) != 7 {
		panic("C scalar call failed")
	}
}
