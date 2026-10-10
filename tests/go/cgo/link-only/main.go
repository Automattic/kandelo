package main

import (
	"fmt"
	_ "unsafe"
)

//go:linkname c_target c_target
func c_target(value int32) int32

//go:linkname weighted weighted
func weighted(value int32) int32

var retained = c_target
var retainedData = weighted

func callWeighted(value int32) int32

func main() {
	if retained == nil || retainedData == nil {
		panic("missing C function")
	}
	if callWeighted(5) != 12 {
		panic("Go-to-C call failed")
	}
	fmt.Println("GO TO C DATA PASS")
}
