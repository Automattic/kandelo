package main

import (
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/dunglas/frankenphp"
)

const documentRoot = "/var/www/html"

func main() {
	threadCount := 2
	if value := os.Getenv("FRANKENPHP_NUM_THREADS"); value != "" {
		configured, err := strconv.Atoi(value)
		if err != nil || configured < 1 {
			log.Fatal("FRANKENPHP_NUM_THREADS must be a positive integer")
		}
		threadCount = configured
	}
	if err := frankenphp.Init(frankenphp.WithNumThreads(threadCount)); err != nil {
		log.Fatal(err)
	}
	defer frankenphp.Shutdown()

	address := os.Getenv("FRANKENPHP_LISTEN")
	if address == "" {
		address = ":8080"
	}
	server := &http.Server{
		Addr:              address,
		Handler:           http.HandlerFunc(serveRequest),
		ReadHeaderTimeout: 10 * time.Second,
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("FrankenPHP classic listening on %s", address)
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func serveRequest(response http.ResponseWriter, request *http.Request) {
	cleanPath := filepath.Clean("/" + request.URL.Path)
	fullPath := filepath.Join(documentRoot, strings.TrimPrefix(cleanPath, "/"))
	info, err := os.Stat(fullPath)
	if err == nil && info.IsDir() {
		cleanPath = filepath.Join(cleanPath, "index.php")
		fullPath = filepath.Join(documentRoot, strings.TrimPrefix(cleanPath, "/"))
		info, err = os.Stat(fullPath)
	}
	if err == nil && info.Mode().IsRegular() && !strings.HasSuffix(strings.ToLower(fullPath), ".php") {
		http.ServeFile(response, request, fullPath)
		return
	}
	if err != nil || !info.Mode().IsRegular() {
		cleanPath = "/index.php"
	}

	phpRequest := request.Clone(request.Context())
	phpRequest.URL.Path = cleanPath
	phpRequest, err = frankenphp.NewRequestWithContext(phpRequest,
		frankenphp.WithRequestResolvedDocumentRoot(documentRoot),
		frankenphp.WithOriginalRequest(request))
	if err != nil {
		http.Error(response, err.Error(), http.StatusBadRequest)
		return
	}
	if err := frankenphp.ServeHTTP(response, phpRequest); err != nil {
		log.Printf("PHP request %q failed: %v", request.URL.Path, err)
		http.Error(response, "PHP request failed", http.StatusInternalServerError)
	}
}
