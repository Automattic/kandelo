package main

import (
	"fmt"
	"runtime"
	"time"
	_ "unsafe"
)

//go:linkname nanotime runtime.nanotime
func nanotime() int64

var spinResult uint64

//go:noinline
func spinStep(value uint64) uint64 {
	// Cooperative preemption needs a split-stack checkpoint. A scalar leaf
	// can be NOSPLIT, so give this step a materialized frame instead of
	// depending on the scheduler's deliberately nosplit clock function.
	var frame [64]uint64
	frame[value%uint64(len(frame))] = value
	result := frame[value%uint64(len(frame))]*1664525 + 1013904223
	runtime.KeepAlive(&frame)
	return result
}

func main() {
	runtime.GOMAXPROCS(1)
	started := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		close(started)
		deadline := nanotime() + 2_000_000_000
		var value uint64
		for nanotime() < deadline {
			for iteration := 0; iteration < 65536; iteration++ {
				value = spinStep(value)
			}
		}
		spinResult = value
		close(finished)
	}()
	<-started
	start := nanotime()
	time.Sleep(100 * time.Millisecond)
	elapsed := nanotime() - start
	select {
	case <-finished:
		panic("CPU-bound goroutine finished before timer fired")
	default:
	}
	if elapsed > 1_000_000_000 {
		panic("timer was starved by CPU-bound goroutine")
	}
	if elapsed < 50_000_000 {
		panic("timer fired too early")
	}
	fmt.Println("sysmon cooperative preemption: complete")
}
