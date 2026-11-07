package main

import (
	"fmt"
	"os"
	"runtime"
	_ "unsafe"
)

//go:linkname getm runtime.getm
func getm() uintptr

//go:linkname nanotime runtime.nanotime
func nanotime() int64

func main() {
	runtime.GOMAXPROCS(2)
	runtime.LockOSThread()
	mainM := getm()
	burst := len(os.Args) > 1 && os.Args[1] == "--burst"
	rounds := 12
	if burst {
		rounds = 64
	}
	for round := 0; round < rounds; round++ {
		started := make(chan struct{})
		go func() {
			deadline := nanotime() + 5_000_000_000
			for {
				runtime.LockOSThread()
				if getm() != mainM {
					break
				}
				runtime.UnlockOSThread()
				if nanotime() > deadline {
					panic("locked goroutine never reached a worker M")
				}
				runtime.Gosched()
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
		if !burst {
			deadline = nanotime() + 100_000_000
			for nanotime() < deadline {
			}
		}
	}
	if burst {
		fmt.Println("locked worker burst exit and slot reuse: complete")
		return
	}
	fmt.Println("locked worker exit and slot reuse: complete")
}
