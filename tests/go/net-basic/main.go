package main

import (
	"fmt"
	"io"
	"net"
	"runtime"
	"time"
)

func roundTrip(network, address string) error {
	listener, err := net.Listen(network, address)
	if err != nil {
		return fmt.Errorf("listen %s: %w", network, err)
	}
	defer listener.Close()
	if listener.Addr().(*net.TCPAddr).Port == 0 {
		return fmt.Errorf("listen %s did not allocate a port", network)
	}

	serverResult := make(chan error, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverResult <- acceptErr
			return
		}
		defer connection.Close()
		if deadlineErr := connection.SetDeadline(time.Now().Add(5 * time.Second)); deadlineErr != nil {
			serverResult <- deadlineErr
			return
		}
		request := make([]byte, 4)
		if _, readErr := io.ReadFull(connection, request); readErr != nil {
			serverResult <- readErr
			return
		}
		if string(request) != "ping" {
			serverResult <- fmt.Errorf("unexpected request: %q", request)
			return
		}
		_, writeErr := connection.Write([]byte("pong"))
		serverResult <- writeErr
	}()

	connection, err := net.DialTimeout(network, listener.Addr().String(), 5*time.Second)
	if err != nil {
		return fmt.Errorf("dial %s: %w", network, err)
	}
	defer connection.Close()
	if err := connection.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	if _, err := connection.Write([]byte("ping")); err != nil {
		return err
	}
	response := make([]byte, 4)
	if _, err := io.ReadFull(connection, response); err != nil {
		return err
	}
	if string(response) != "pong" {
		return fmt.Errorf("unexpected response: %q", response)
	}
	if err := <-serverResult; err != nil {
		return err
	}
	return nil
}

func main() {
	runtime.GOMAXPROCS(2)
	for _, testcase := range []struct {
		network string
		address string
	}{
		{network: "tcp4", address: "127.0.0.1:0"},
		{network: "tcp6", address: "[::1]:0"},
	} {
		if err := roundTrip(testcase.network, testcase.address); err != nil {
			panic(err)
		}
	}
	fmt.Println("GO NET PASS")
}
