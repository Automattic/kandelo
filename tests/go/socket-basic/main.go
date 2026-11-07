package main

import (
	"fmt"
	"syscall"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func runLoopback(domain int, bindAddress syscall.Sockaddr) {
	listener, err := syscall.Socket(domain, syscall.SOCK_STREAM, 0)
	must(err)
	defer syscall.Close(listener)
	must(syscall.SetsockoptInt(listener, syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1))
	reuse, err := syscall.GetsockoptInt(listener, syscall.SOL_SOCKET, syscall.SO_REUSEADDR)
	must(err)
	if reuse != 1 {
		panic("socket option mismatch")
	}
	must(syscall.Bind(listener, bindAddress))
	must(syscall.Listen(listener, 1))
	local, err := syscall.Getsockname(listener)
	must(err)
	port := 0
	switch address := local.(type) {
	case *syscall.SockaddrInet4:
		port = address.Port
	case *syscall.SockaddrInet6:
		port = address.Port
	}
	if port == 0 {
		panic("invalid listener address")
	}

	client, err := syscall.Socket(domain, syscall.SOCK_STREAM, 0)
	must(err)
	defer syscall.Close(client)
	must(syscall.Connect(client, local))
	server, peer, err := syscall.Accept(listener)
	must(err)
	defer syscall.Close(server)
	if peer == nil {
		panic("invalid peer address")
	}
	_, err = syscall.Getpeername(client)
	must(err)
	option, err := syscall.GetsockoptInt(client, syscall.SOL_SOCKET, syscall.SO_ERROR)
	must(err)
	if option != 0 {
		panic("socket error")
	}

	message := []byte("go socket loopback")
	written, err := syscall.Write(client, message)
	must(err)
	if written != len(message) {
		panic("short socket write")
	}
	buffer := make([]byte, len(message))
	read, err := syscall.Read(server, buffer)
	must(err)
	if read != len(message) || string(buffer) != string(message) {
		panic("socket payload mismatch")
	}
}

func main() {
	runLoopback(syscall.AF_INET, &syscall.SockaddrInet4{Addr: [4]byte{127, 0, 0, 1}})
	runLoopback(syscall.AF_INET6, &syscall.SockaddrInet6{Addr: [16]byte{15: 1}})
	fmt.Println("GO SOCKET PASS")
}
