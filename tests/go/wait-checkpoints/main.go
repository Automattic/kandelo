//go:build kandelo

package main

import (
	"fmt"
	"sync/atomic"
	"time"
	_ "unsafe"
)

// This runtime fixture observes the target's existing private wait policy;
// ordinary applications do not access these implementation details.
//
//go:linkname hostWaitBound runtime.kandeloHeapSafepointBound
var hostWaitBound uint64

//go:linkname runtimeSleep runtime.usleep
func runtimeSleep(usec uint32)

func main() {
	const sentinel = 50_000_000
	for round := 0; round < 3; round++ {
		started := time.Now()
		atomic.StoreUint64(&hostWaitBound, sentinel)
		runtimeSleep(350_000)
		bound := atomic.LoadUint64(&hostWaitBound)
		elapsed := time.Since(started)
		fmt.Printf("wait round=%d bound=%d elapsed=%s\n", round, int64(bound), elapsed)
		if bound != 100_000_000 && int64(bound) != -1 {
			panic("runtime wait did not obtain the host checkpoint policy")
		}
		if elapsed < 350*time.Millisecond {
			panic("checkpoint interval shortened the requested sleep")
		}
	}
	fmt.Println("GO WAIT CHECKPOINT PASS")
}
