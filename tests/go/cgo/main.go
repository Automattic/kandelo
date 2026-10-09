package main

/*
#include <stdlib.h>
*/
import "C"

func main() {
	if C.abs(-7) != 7 {
		panic("C call failed")
	}
}
