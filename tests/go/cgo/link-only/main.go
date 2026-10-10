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

//go:linkname tls_weighted tls_weighted
func tls_weighted(value int32) int32

//go:linkname call_function_pointer call_function_pointer
func call_function_pointer(value int32) int32

var retained = c_target
var retainedData = weighted
var retainedCrossData = cross_weighted
var retainedTLS = tls_weighted
var retainedFunctionPointer = call_function_pointer

func callWeighted(value int32) int32
func callCrossWeighted(value int32) int32
func callTLSWeighted(value int32) int32
func callFunctionPointer(value int32) int32

func main() {
	if retained == nil || retainedData == nil || retainedCrossData == nil || retainedTLS == nil || retainedFunctionPointer == nil {
		panic("missing C function")
	}
	if callWeighted(5) != 12 {
		panic("Go-to-C call failed")
	}
	if callCrossWeighted(5) != 13 {
		panic("cross-object C data call failed")
	}
	if callTLSWeighted(5) != 12 || callTLSWeighted(5) != 13 {
		panic("C TLS call failed")
	}
	if callFunctionPointer(5) != 8 {
		panic("C function pointer call failed")
	}
	fmt.Println("GO TO C DATA PASS")
}
