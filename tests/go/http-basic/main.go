package main

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"runtime"
	"time"
)

func roundTrip(network, address string) error {
	listener, err := net.Listen(network, address)
	if err != nil {
		return err
	}
	defer listener.Close()

	server := &http.Server{
		Handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path != "/hello" {
				http.NotFound(writer, request)
				return
			}
			writer.Header().Set("Content-Type", "text/plain")
			_, _ = io.WriteString(writer, "hello from Kandelo")
		}),
	}
	serverResult := make(chan error, 1)
	go func() { serverResult <- server.Serve(listener) }()
	defer func() {
		server.Close()
		<-serverResult
	}()

	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Get("http://" + listener.Addr().String() + "/hello")
	if err != nil {
		return fmt.Errorf("GET %s: %w", network, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: unexpected status %d", network, response.StatusCode)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return err
	}
	if string(body) != "hello from Kandelo" {
		return fmt.Errorf("GET %s: unexpected body %q", network, body)
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
	fmt.Println("GO HTTP PASS")
}
