package main

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"sync"
	"time"
	_ "unsafe"
)

//go:linkname getm runtime.getm
func getm() uintptr

func main() {
	workers := 48
	if len(os.Args) > 1 {
		count, err := strconv.Atoi(os.Args[1])
		if err != nil || count < 1 || count > 1023 {
			panic("invalid locked Go thread count")
		}
		workers = count
	}
	runtime.GOMAXPROCS(workers + 2)
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	mainM := getm()
	started := make(chan uintptr, workers)
	release := make(chan struct{})
	var done sync.WaitGroup
	for range workers {
		done.Add(1)
		go func() {
			runtime.LockOSThread()
			defer runtime.UnlockOSThread()
			defer done.Done()
			started <- getm()
			<-release
		}()
	}
	seen := make(map[uintptr]bool, workers)
	deadline := time.NewTimer(60*time.Second + time.Duration(workers)*250*time.Millisecond)
	defer deadline.Stop()
	for range workers {
		select {
		case workerM := <-started:
			if workerM == mainM || seen[workerM] {
				panic("locked goroutines shared an M")
			}
			seen[workerM] = true
		case <-deadline.C:
			panic("locked workers did not start")
		}
	}
	close(release)
	done.Wait()
	fmt.Printf("%d concurrent locked Go threads: complete\n", workers)
}
