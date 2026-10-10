package main

import (
	"fmt"
	"runtime"
	_ "unsafe"
)

//go:linkname kandeloThreadLockState runtime.kandeloThreadLockState
func kandeloThreadLockState() bool

//go:linkname getm runtime.getm
func getm() uintptr

func main() {
	runtime.GOMAXPROCS(2)
	done := make(chan struct{})
	go func() {
		runtime.LockOSThread()
		if !kandeloThreadLockState() {
			panic("goroutine was not locked to its M")
		}
		thread := getm()
		for iteration := 0; iteration < 64; iteration++ {
			runtime.Gosched()
			if getm() != thread || !kandeloThreadLockState() {
				panic("locked goroutine migrated")
			}
		}
		runtime.UnlockOSThread()
		if kandeloThreadLockState() {
			panic("goroutine stayed locked after unlock")
		}
		close(done)
	}()
	<-done
	fmt.Println("locked worker affinity: complete")
}
