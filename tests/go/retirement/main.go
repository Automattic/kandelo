package main

import (
	"fmt"
	"os"
	"runtime"
)

func main() {
	runtime.LockOSThread()
	reader, writer, err := os.Pipe()
	if err != nil {
		panic(err)
	}
	defer writer.Close()
	fmt.Println("GO RETIREMENT READY")
	var buffer [1]byte
	_, err = reader.Read(buffer[:])
	panic(fmt.Sprintf("blocked read returned instead of retiring: %v", err))
}
