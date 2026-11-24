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
	"strconv"
	"sync/atomic"
	"syscall"
	"time"
)

const payload = "hello from Kandelo"

var initializedWord uint32 = 0x71b3de42

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

func checkThreadInitialization() {
	const changed = 0x8437a12c
	const threads = 8
	atomic.StoreUint32(&initializedWord, changed)
	// Start more runtime threads than the slot limit across several rounds.
	// Returning while locked retires each worker so its slot can be reused.
	for range 5 {
		ready := make(chan struct{}, threads)
		release := make(chan struct{})
		done := make(chan struct{}, threads)
		for range threads {
			go func() {
				runtime.LockOSThread()
				ready <- struct{}{}
				<-release
				done <- struct{}{}
			}()
		}
		for range threads {
			<-ready
		}
		runtime.GC()
		if atomic.LoadUint32(&initializedWord) != changed {
			panic("thread startup reset initialized process data")
		}
		close(release)
		for range threads {
			<-done
		}
	}
}

func checkParallelism(want int) {
	if got := runtime.GOMAXPROCS(0); got != want {
		panic(fmt.Sprintf("GOMAXPROCS = %d, want %d", got, want))
	}
	if want == 1 {
		return
	}
	var arrived atomic.Int32
	ready := make(chan struct{}, want)
	release := make(chan struct{})
	done := make(chan struct{}, want)
	for range want {
		go func() {
			runtime.LockOSThread()
			waitForProcessors(&arrived, int32(want))
			ready <- struct{}{}
			<-release
			runtime.UnlockOSThread()
			done <- struct{}{}
		}()
	}
	for range want {
		<-ready
	}
	if got := runtime.GOMAXPROCS(1); got != want {
		panic("could not resize the running scheduler")
	}
	if got := runtime.GOMAXPROCS(want); got != 1 {
		panic("could not restore the running scheduler")
	}
	close(release)
	for range want {
		<-done
	}
}

// The participants must each run with their own P because this loop
// cannot yield. The test host bounds the wait if a participant stalls.
//
//go:nosplit
//go:noinline
func waitForProcessors(arrived *atomic.Int32, want int32) {
	arrived.Add(1)
	for arrived.Load() != want {
	}
}

//go:noinline
func spinWithoutCalls() {
	for {
	}
}

func checkLoopPreemption() {
	runtime.GOMAXPROCS(1)
	ready := make(chan struct{})
	go func() {
		close(ready)
		spinWithoutCalls()
	}()
	<-ready
	<-time.After(20 * time.Millisecond)
	runtime.GC()
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
	procs := 1
	if len(os.Args) > 1 {
		var err error
		procs, err = strconv.Atoi(os.Args[1])
		must(err)
	}
	checkParallelism(procs)
	checkRuntime()
	checkThreadInitialization()
	fmt.Println("Go goroutines and GC OK")
	checkFiles()
	fmt.Println("Go file I/O OK")
	checkTCP()
	fmt.Println("Go loopback TCP OK")
	checkSubprocess()
	fmt.Println("Go subprocess OK")
	checkShutdown()
	fmt.Println("Go shutdown OK")
	checkLoopPreemption()
	fmt.Println("Go loop preemption OK")
}
