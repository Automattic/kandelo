package main

/*
#include <stdlib.h>
static int add_three(int first, int second, int third) { return first + second + third; }
static int add_pointed(const int *value, int extra) { return *value + extra; }
static int add_middle_pointer(int first, const int *value, int last) { return first + *value + last; }
*/
import "C"

import "fmt"

func main() {
	if result := C.abs(-7); result != 7 {
		panic(fmt.Sprintf("C call failed: got %d", result))
	}
	if result := C.add_three(2, 3, 4); result != 9 {
		panic(fmt.Sprintf("C scalar arguments failed: got %d", result))
	}
	value := C.int(5)
	if result := C.add_pointed(&value, 6); result != 11 {
		panic(fmt.Sprintf("C pointer argument failed: got %d", result))
	}
	if result := C.add_middle_pointer(2, &value, 6); result != 13 {
		panic(fmt.Sprintf("C middle pointer argument failed: got %d", result))
	}
	fmt.Println("CGO ABS PASS")
}
