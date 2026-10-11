package main

import (
	"crypto/rand"
	"fmt"
	"os"
	"syscall"
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
	randomBytes := make([]byte, 16)
	if _, err := rand.Read(randomBytes); err != nil {
		panic(err)
	}
	allZero := true
	for _, randomByte := range randomBytes {
		if randomByte != 0 {
			allZero = false
			break
		}
	}
	if allZero {
		panic("random source returned only zeroes")
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
	atime := time.Unix(1_790_000_000, 123_456_789)
	mtime := time.Unix(1_790_000_001, 987_654_321)
	if err := os.Chtimes("/tmp/go-browser-port/new", atime, mtime); err != nil {
		panic(err)
	}
	stat, err := os.Stat("/tmp/go-browser-port/new")
	if err != nil || !stat.ModTime().Equal(mtime) {
		panic("nanosecond timestamps did not round trip")
	}
	var raw syscall.Stat_t
	if err := syscall.Stat("/tmp/go-browser-port/new", &raw); err != nil || raw.Atime != uint64(atime.UnixNano()) {
		panic("nanosecond access time did not round trip")
	}
	if err := os.Remove("/tmp/go-browser-port/new"); err != nil {
		panic(err)
	}
	if err := os.Remove("/tmp/go-browser-port"); err != nil {
		panic(err)
	}
	fmt.Println("GO BASIC PASS")
}
