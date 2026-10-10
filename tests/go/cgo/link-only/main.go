package main

import (
	"fmt"
	_ "unsafe"
)

//go:linkname c_target c_target
func c_target(value int32) int32

//go:linkname weighted weighted
func weighted(value int32) int32

//go:linkname cross_weighted cross_weighted
func cross_weighted(value int32) int32

var retained = c_target
var retainedData = weighted
var retainedCrossData = cross_weighted

func callWeighted(value int32) int32
func callCrossWeighted(value int32) int32

func main() {
	if retained == nil || retainedData == nil || retainedCrossData == nil {
		panic("missing C function")
	}
	if callWeighted(5) != 12 {
		panic("Go-to-C call failed")
	}
	if callCrossWeighted(5) != 13 {
		panic("cross-object C data call failed")
	}
	fmt.Println("GO TO C DATA PASS")
}
