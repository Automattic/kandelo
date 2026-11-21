package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

const payload = "hello from Kandelo"

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func checkRuntime() {
	out := make(chan []byte)
	go func() {
		// Retire a locked runtime thread when the goroutine returns.
		runtime.LockOSThread()
		b := make([]byte, 2<<20)
		copy(b, payload)
		out <- b
	}()
	b := <-out
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	runtime.GC()
	runtime.ReadMemStats(&after)
	if after.NumGC <= before.NumGC || string(b[:len(payload)]) != payload {
		panic("GC did not complete with the live goroutine result intact")
	}
}

func checkFiles() {
	dir, err := os.MkdirTemp("/tmp", "go-sdk-")
	must(err)
	defer os.RemoveAll(dir)
	from := filepath.Join(dir, "from")
	to := filepath.Join(dir, "to")
	must(os.WriteFile(from, []byte(payload), 0600))
	must(os.Rename(from, to))
	data, err := os.ReadFile(to)
	must(err)
	if string(data) != payload {
		panic("file contents changed")
	}
}

func checkTCP() {
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	must(err)
	defer listener.Close()
	must(listener.SetDeadline(time.Now().Add(5 * time.Second)))
	done := make(chan error, 1)
	go func() {
		conn, err := listener.AcceptTCP()
		if err == nil {
			_, err = io.WriteString(conn, payload)
			conn.Close()
		}
		done <- err
	}()
	conn, err := net.DialTimeout("tcp4", listener.Addr().String(), 5*time.Second)
	must(err)
	defer conn.Close()
	must(conn.SetReadDeadline(time.Now().Add(5 * time.Second)))
	buf := make([]byte, len(payload))
	_, err = io.ReadFull(conn, buf)
	must(err)
	must(<-done)
	if string(buf) != payload {
		panic("loopback payload mismatch")
	}
}

func checkSubprocess() {
	self, err := os.Executable()
	must(err)
	out, err := exec.Command(self, "--child").Output()
	var status *exec.ExitError
	if !errors.As(err, &status) || status.ExitCode() != 23 || string(out) != "child\n" {
		panic(fmt.Sprintf("subprocess output %q, status %v", out, err))
	}
}

func checkShutdown() {
	termination := make(chan os.Signal, 1)
	signal.Notify(termination, syscall.SIGTERM)
	defer signal.Stop(termination)
	must(syscall.Kill(os.Getpid(), syscall.SIGTERM))
	select {
	case <-termination:
	case <-time.After(5 * time.Second):
		panic("timed out waiting for SIGTERM")
	}
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--child" {
		fmt.Println("child")
		os.Exit(23)
	}
	checkRuntime()
	fmt.Println("Go goroutines and GC OK")
	checkFiles()
	fmt.Println("Go file I/O OK")
	checkTCP()
	fmt.Println("Go loopback TCP OK")
	checkSubprocess()
	fmt.Println("Go subprocess OK")
	checkShutdown()
	fmt.Println("Go shutdown OK")
}
