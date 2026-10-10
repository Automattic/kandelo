package main

import (
	"fmt"
	"os"
	"runtime"
	"time"
)

func main() {
	runtime.GOMAXPROCS(2)
	go func() {
		fmt.Println("worker M: exiting process")
		os.Exit(0)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
	}
	panic("worker did not exit process")
}
