//go:build kandelo && cgo

package main

/*
#include <stdlib.h>
#include <stdint.h>
static void *allocate_touched(size_t size) {
    volatile unsigned char *p = malloc(size);
    if (!p) return NULL;
    for (size_t i = 0; i < size; i += 4096) p[i] = 0x5a;
    return (void *)p;
}
static uint64_t linear_bytes(void) {
    return (uint64_t)__builtin_wasm_memory_size(0) * 65536;
}
*/
import "C"

import (
	"encoding/json"
	"fmt"
	"runtime"
	"runtime/debug"
)

const mib = 1024 * 1024

func snapshot(phase string) uint64 {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	linear := uint64(C.linear_bytes())
	row := struct {
		Phase                         string
		LinearBytes, GoSys, HeapAlloc uint64
		HeapIdle, HeapReleased        uint64
		GoRuntimeBudgetBytes          uint64
		ConfiguredGoLimit             int64
	}{phase, linear, m.Sys, m.HeapAlloc, m.HeapIdle, m.HeapReleased,
		m.Sys - m.HeapReleased, debug.SetMemoryLimit(-1)}
	bytes, err := json.Marshal(row)
	if err != nil {
		panic(err)
	}
	fmt.Println(string(bytes))
	return linear
}

// Keep the allocation in a separate frame so collection after return tests
// genuinely dead data. A live set above GOMEMLIMIT is valid: it is a soft
// Go-runtime budget, not a hard cap on the whole Wasm process.
func goAllocation(round int) uint64 {
	data := make([]byte, 64*mib)
	for i := 0; i < len(data); i += 4096 {
		data[i] = byte(i / 4096)
	}
	for i := 0; i < len(data); i += 4096 {
		if data[i] != byte(i/4096) {
			panic("Go allocation contents changed")
		}
	}
	linear := snapshot(fmt.Sprintf("go-live-%d", round))
	runtime.KeepAlive(data)
	return linear
}

func main() {
	debug.SetMemoryLimit(32 * mib)
	snapshot("initial")
	cMemory := C.allocate_touched(32 * mib)
	if cMemory == nil {
		panic("C allocation failed")
	}
	snapshot("c-live")
	firstPeak := goAllocation(0)
	for round := 1; round <= 3; round++ {
		debug.FreeOSMemory()
		snapshot(fmt.Sprintf("go-scavenged-%d", round))
		goAllocation(round)
	}
	debug.FreeOSMemory()
	finalLinear := snapshot("go-scavenged-final")
	C.free(cMemory)
	snapshot("c-freed")
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	if m.HeapAlloc > 16*mib {
		panic("dead Go allocation remains live")
	}
	if finalLinear > firstPeak+16*mib {
		panic("repeated allocation did not reuse bounded linear memory")
	}
	fmt.Println("GO MEMORY ACCOUNTING PASS")
}
