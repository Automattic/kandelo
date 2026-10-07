package main

import (
	"fmt"
	"runtime"
	"sync/atomic"
	_ "unsafe"
)

//go:linkname kandeloSpawnProbeM runtime.kandeloSpawnProbeM
func kandeloSpawnProbeM()

//go:linkname nanotime runtime.nanotime
func nanotime() int64

func main() {
	runtime.GOMAXPROCS(2)
	for round := 0; round < 2; round++ {
		var running atomic.Int32
		done := make(chan struct{}, 2)
		for worker := 0; worker < 2; worker++ {
			go func() {
				running.Add(1)
				deadline := nanotime() + 5_000_000_000
				for running.Load() < 2 {
					if nanotime() > deadline {
						panic("clone parents did not overlap")
					}
				}
				kandeloSpawnProbeM()
				done <- struct{}{}
			}()
		}
		<-done
		<-done
	}
	fmt.Println("parallel clone handoffs: complete")
}
