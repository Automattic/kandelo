package main

import _ "unsafe"

//go:linkname c_target c_target
func c_target(value int32) int32

var retained = c_target

func main() {
	if retained == nil {
		panic("missing C function")
	}
}
