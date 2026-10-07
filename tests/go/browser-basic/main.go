package main

import (
	"fmt"
	"os"
	"time"
)

func main() {
	if len(os.Args) != 3 || os.Args[1] != "alpha" || os.Args[2] != "beta" {
		panic("argv mismatch")
	}
	if os.Getenv("KANDELO_GO_BROWSER") != "present" {
		panic("environ mismatch")
	}
	if time.Now().UnixNano() <= 0 {
		panic("clock unavailable")
	}
	input, err := os.ReadFile("/etc/go-browser-input")
	if err != nil || string(input) != "browser fixture\n" {
		panic("mounted file mismatch")
	}
	if err := os.Mkdir("/tmp/go-browser-port", 0700); err != nil {
		panic(err)
	}
	if err := os.WriteFile("/tmp/go-browser-port/old", input, 0600); err != nil {
		panic(err)
	}
	if err := os.Rename("/tmp/go-browser-port/old", "/tmp/go-browser-port/new"); err != nil {
		panic(err)
	}
	output, err := os.ReadFile("/tmp/go-browser-port/new")
	if err != nil || string(output) != string(input) {
		panic("file round trip mismatch")
	}
	if err := os.Remove("/tmp/go-browser-port/new"); err != nil {
		panic(err)
	}
	if err := os.Remove("/tmp/go-browser-port"); err != nil {
		panic(err)
	}
	fmt.Println("GO BASIC PASS")
}
