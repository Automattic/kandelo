package main

/*
#include <stdlib.h>
*/
import "C"

import "fmt"

func main() {
	if C.abs(-7) != 7 {
		panic("C call failed")
	}
	fmt.Println("CGO ABS PASS")
}
