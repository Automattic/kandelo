package main

import (
	"fmt"
	"runtime"
	_ "unsafe"
)

//go:linkname getm runtime.getm
func getm() uintptr

//go:linkname nanotime runtime.nanotime
func nanotime() int64

func main() {
	runtime.GOMAXPROCS(2)
	mainM := getm()
	for round := 0; round < 12; round++ {
		started := make(chan struct{})
		go func() {
			runtime.LockOSThread()
			if getm() == mainM {
				panic("locked goroutine ran on main M")
			}
			close(started)
		}()
		deadline := nanotime() + 5_000_000_000
		for {
			select {
			case <-started:
				goto startedWorker
			default:
				if nanotime() > deadline {
					panic("locked goroutine did not start")
				}
			}
		}
	startedWorker:
		deadline = nanotime() + 100_000_000
		for nanotime() < deadline {
		}
	}
	fmt.Println("locked worker exit and slot reuse: complete")
}
