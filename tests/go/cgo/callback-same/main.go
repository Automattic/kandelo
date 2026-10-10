package main

/*
extern int go_double(int value);
static int call_go(int value) { return go_double(value); }
*/
import "C"

import "fmt"

//export go_double
func go_double(value C.int) C.int {
	return value * 2
}

func main() {
	if result := C.call_go(7); result != 14 {
		panic(fmt.Sprintf("C callback failed: got %d", result))
	}
	fmt.Println("CGO CALLBACK PASS")
}
