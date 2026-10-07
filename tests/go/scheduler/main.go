package main

import (
	"fmt"
	"runtime"
	"sync/atomic"
	"time"
)

func main() {
	runtime.GOMAXPROCS(2)
	fmt.Println("GOMAXPROCS:", runtime.GOMAXPROCS(0))
	var running atomic.Int32
	done := make(chan struct{}, 2)
	for worker := 0; worker < 2; worker++ {
		go func() {
			running.Add(1)
			deadline := time.Now().Add(5 * time.Second)
			for running.Load() < 2 {
				if time.Now().After(deadline) {
					panic("workers did not overlap")
				}
			}
			done <- struct{}{}
		}()
	}
	<-done
	<-done
	fmt.Println("parallel M: complete")
}
