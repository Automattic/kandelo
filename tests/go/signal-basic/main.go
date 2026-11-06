package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"
	"unsafe"
)

var foreignSignalProbe func()
var foreignHandlerProbe func()
var foreignRestartSetup func(int)

func receive(signals <-chan os.Signal) {
	select {
	case got := <-signals:
		if got != syscall.SIGUSR1 {
			panic(fmt.Sprintf("wrong signal: %v", got))
		}
	case <-time.After(5 * time.Second):
		panic("signal notification timed out")
	}
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "http-drain" {
		httpDrain()
		return
	}
	runtime.LockOSThread()
	if len(os.Args) > 1 && os.Args[1] == "signal-gc" {
		signalDuringGC()
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "blocked-wait" {
		blockedWait()
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "quit" {
		fmt.Println("GO SIGNAL QUIT READY")
		if err := syscall.Kill(os.Getpid(), syscall.SIGQUIT); err != nil {
			panic(err)
		}
		panic("default SIGQUIT did not terminate")
	}
	if len(os.Args) > 1 && os.Args[1] == "restart" {
		restartRead()
		return
	}
	// Go's default for SIGUSR1 is to catch it without taking action.
	if err := syscall.Kill(os.Getpid(), syscall.SIGUSR1); err != nil {
		panic(err)
	}
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, syscall.SIGUSR1)
	if err := syscall.Kill(os.Getpid(), syscall.SIGUSR1); err != nil {
		panic(err)
	}
	receive(signals)
	fmt.Println("GO SIGNAL NOTIFY PASS")
	if len(os.Args) > 1 && (os.Args[1] == "reset" || os.Args[1] == "stop") {
		signal.Notify(signals, syscall.SIGTERM)
		if os.Args[1] == "reset" {
			signal.Reset(syscall.SIGTERM)
		} else {
			signal.Stop(signals)
		}
		if err := syscall.Kill(os.Getpid(), syscall.SIGTERM); err != nil {
			panic(err)
		}
		panic("default SIGTERM disposition did not terminate the process")
	}

	reader, writer, err := os.Pipe()
	if err != nil {
		panic(err)
	}
	go func() {
		if err := syscall.Kill(os.Getpid(), syscall.SIGUSR1); err != nil {
			panic(err)
		}
		receive(signals)
		if _, err := writer.Write([]byte("x")); err != nil {
			panic(err)
		}
	}()
	var value [1]byte
	if n, err := reader.Read(value[:]); err != nil || n != 1 || value[0] != 'x' {
		panic(fmt.Sprintf("interrupted pipe read failed: %q: %v", value, err))
	}
	reader.Close()
	writer.Close()
	fmt.Println("GO SIGNAL IO LIVENESS PASS")

	if foreignSignalProbe != nil {
		foreignSignalProbe()
		receive(signals)
		fmt.Println("GO SIGNAL CGO PASS")
	}
	if foreignHandlerProbe != nil {
		foreignHandlerProbe()
		fmt.Println("GO SIGNAL C HANDLER PASS")
	}
	signal.Ignore(syscall.SIGUSR2)
	if !signal.Ignored(syscall.SIGUSR2) {
		panic("ignored signal not reported")
	}
	if err := syscall.Kill(os.Getpid(), syscall.SIGUSR2); err != nil {
		panic(err)
	}
	// Notify overrides Ignore. Reset only promises to undo Notify, not
	// to clear the runtime's record of an explicit Ignore call.
	ignoredSignals := make(chan os.Signal, 1)
	signal.Notify(ignoredSignals, syscall.SIGUSR2)
	if signal.Ignored(syscall.SIGUSR2) {
		panic("notification signal remains ignored")
	}
	signal.Stop(ignoredSignals)
	signal.Stop(signals)
	checkWideSeek()
	fmt.Println("GO SIGNAL PASS")
}

//go:noinline
func growSignalStack(depth int) byte {
	var padding [1024]byte
	padding[depth%len(padding)] = byte(depth)
	if depth > 0 {
		padding[0] = growSignalStack(depth - 1)
	}
	runtime.KeepAlive(&padding)
	return padding[depth%len(padding)]
}

func signalDuringGC() {
	const rounds = 12
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGUSR1)
	defer signal.Stop(signals)
	reader, writer, err := os.Pipe()
	if err != nil {
		panic(err)
	}
	defer reader.Close()
	defer writer.Close()
	fd := int(reader.Fd())
	go func() {
		var control [1]byte
		for round := 0; round < rounds; round++ {
			if n, err := os.Stdin.Read(control[:]); n != 1 || err != nil || control[0] != 'g' {
				panic("missing GC control byte")
			}
			runtime.GC()
			fmt.Printf("GO SIGNAL GC DONE round=%d\n", round)
		}
	}()
	var value [1]byte
	for round := 0; round < rounds; round++ {
		growSignalStack(128 + round)
		before := uintptr(unsafe.Pointer(&value[0]))
		fmt.Printf("GO SIGNAL GC READ round=%d fd=%d\n", round, fd)
		if n, err := syscall.Read(fd, value[:]); n != 0 || err != syscall.EINTR {
			panic(fmt.Sprintf("signal completion changed during GC: n=%d err=%v", n, err))
		}
		receive(signals)
		fmt.Printf("GO SIGNAL GC STACK MOVED=%t\n", before != uintptr(unsafe.Pointer(&value[0])))
	}
	fmt.Println("GO SIGNAL GC PASS")
}

func blockedWait() {
	reader, writer, err := os.Pipe()
	if err != nil {
		panic(err)
	}
	defer reader.Close()
	defer writer.Close()
	go func() {
		time.Sleep(400 * time.Millisecond)
		if _, err := writer.Write([]byte("s")); err != nil {
			panic(err)
		}
	}()
	var value [1]byte
	if n, err := reader.Read(value[:]); n != 1 || err != nil || value[0] != 's' {
		panic(fmt.Sprintf("bounded wait returned before syscall completion: %d %q %v", n, value, err))
	}
	fmt.Println("GO SAFEPOINT WAIT PASS")
}

func restartRead() {
	if foreignRestartSetup == nil {
		panic("restart mode needs cgo")
	}
	reader, writer, err := os.Pipe()
	if err != nil {
		panic(err)
	}
	defer reader.Close()
	defer writer.Close()
	fd := int(reader.Fd())
	foreignRestartSetup(int(writer.Fd()))
	fmt.Printf("GO SIGNAL RESTART READY fd=%d\n", fd)
	var value [1]byte
	if n, err := syscall.Read(fd, value[:]); n != 1 || err != nil || value[0] != 'r' {
		panic(fmt.Sprintf("SA_RESTART read failed: %d %q %v", n, value, err))
	}
	fmt.Println("GO SIGNAL RESTART PASS")
}

func checkWideSeek() {
	file, err := os.OpenFile("/tmp/go-signal-seek", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		panic(err)
	}
	defer os.Remove(file.Name())
	defer file.Close()
	const offset = int64(1) << 33
	if got, err := file.Seek(offset, 0); err != nil || got != offset {
		panic(fmt.Sprintf("wide seek failed: %d %v", got, err))
	}
	if got, err := file.Seek(0, 1); err != nil || got != offset {
		panic(fmt.Sprintf("wide position truncated: %d %v", got, err))
	}
}

func httpDrain() {
	termination := make(chan os.Signal, 1)
	signal.Notify(termination, syscall.SIGTERM)
	defer signal.Stop(termination)
	listener, err := net.Listen("tcp", ":8080")
	if err != nil {
		panic(err)
	}
	finishRequest := make(chan struct{})
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Println("GO SIGNAL REQUEST STARTED")
		<-finishRequest
		fmt.Fprintln(w, "request completed during shutdown")
	})}
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			panic(err)
		}
	}()
	fmt.Println("GO SIGNAL HTTP READY")
	<-termination
	fmt.Println("GO SIGNAL TERM RECEIVED")
	close(finishRequest)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		panic(err)
	}
	fmt.Println("GO SIGNAL HTTP DRAIN PASS")
}
