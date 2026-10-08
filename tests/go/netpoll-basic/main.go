package main

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"syscall"
	"time"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func main() {
	runtime.GOMAXPROCS(2)
	listener, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM, 0)
	must(err)
	defer syscall.Close(listener)
	must(syscall.Bind(listener, &syscall.SockaddrInet4{Addr: [4]byte{127, 0, 0, 1}}))
	must(syscall.Listen(listener, 1))
	address, err := syscall.Getsockname(listener)
	must(err)
	client, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM, 0)
	must(err)
	defer syscall.Close(client)
	must(syscall.Connect(client, address))
	accepted, _, err := syscall.Accept(listener)
	must(err)
	must(syscall.SetNonblock(accepted, true))
	flags, err := syscall.Fcntl(accepted, syscall.F_GETFL, 0)
	must(err)
	if flags&syscall.O_NONBLOCK == 0 {
		panic("nonblocking flag missing")
	}
	server := os.NewFile(uintptr(accepted), "tcp-server")
	if server == nil {
		panic("os.NewFile failed")
	}
	defer server.Close()
	must(server.SetReadDeadline(time.Now().Add(50 * time.Millisecond)))
	buffer := make([]byte, 32)
	_, err = server.Read(buffer)
	if !errors.Is(err, os.ErrDeadlineExceeded) {
		panic(fmt.Sprintf("read deadline: %v", err))
	}
	must(server.SetReadDeadline(time.Now().Add(5 * time.Second)))
	written := make(chan error, 1)
	go func() {
		time.Sleep(50 * time.Millisecond)
		_, writeErr := syscall.Write(client, []byte("poll wakeup"))
		written <- writeErr
	}()
	count, err := server.Read(buffer)
	must(err)
	must(<-written)
	if string(buffer[:count]) != "poll wakeup" {
		panic("socket read mismatch")
	}
	readStarted := make(chan struct{})
	readFinished := make(chan error, 1)
	go func() {
		close(readStarted)
		_, readErr := server.Read(buffer)
		readFinished <- readErr
	}()
	<-readStarted
	time.Sleep(50 * time.Millisecond)
	must(server.Close())
	select {
	case readErr := <-readFinished:
		if readErr == nil || errors.Is(readErr, os.ErrDeadlineExceeded) {
			panic(fmt.Sprintf("read after close: %v", readErr))
		}
	case <-time.After(time.Second):
		panic("close did not unblock read")
	}
	fmt.Println("GO NETPOLL PASS")
}
