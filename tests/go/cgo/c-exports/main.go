package main

/*
#cgo LDFLAGS: -L${SRCDIR}/lib -lprobe -ldl
#include <dlfcn.h>

int used(int value);

static int run_side_module(void) {
    void *module = dlopen("/lib/libprobe.so", RTLD_NOW);
    if (module == 0) return -1;
    int (*side_result)(void) = (int (*)(void))dlsym(module, "side_result");
    if (side_result == 0) return -2;
    int result = side_result();
    if (dlclose(module) != 0) return -3;
    return result;
}
*/
import "C"

import "fmt"

func main() {
	result := C.run_side_module()
	if C.used(4) != 8 || result != 39 {
		panic(fmt.Sprintf("C side-module import failed: %d", int(result)))
	}
	fmt.Println("CGO C EXPORT DLOPEN PASS")
}
