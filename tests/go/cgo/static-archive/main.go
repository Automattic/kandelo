package main

/*
#cgo LDFLAGS: -L${SRCDIR}/lib -lsquare -lempty-gnu -lcompat
extern int square_with_bias(int value);
*/
import "C"

import "fmt"

func main() {
	if C.square_with_bias(7) != 50 {
		panic("static archive call failed")
	}
	fmt.Println("CGO STATIC ARCHIVE PASS")
}
