//go:build cgo

package main

/*
#include <stdlib.h>
*/
import "C"

func init() {
	if C.abs(-7) != 7 {
		panic("cgo startup failed")
	}
}
