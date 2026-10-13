package main

import (
	"fmt"
	_ "unsafe"
)

//go:linkname kandeloSpawnProbeM runtime.kandeloSpawnProbeM
func kandeloSpawnProbeM()

//go:linkname nanotime runtime.nanotime
func nanotime() int64

func main() {
	fmt.Println("M1: before spawn")
	for threadNumber := 0; threadNumber < 5; threadNumber++ {
		kandeloSpawnProbeM()
	}
	deadline := nanotime() + 1_500_000_000
	for nanotime() < deadline {
	}
	fmt.Println("M1: after spawn")
}
