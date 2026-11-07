package main

import (
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	appLogger "github.com/roadrunner-server/app-logger/v5"
	configPlugin "github.com/roadrunner-server/config/v5"
	"github.com/roadrunner-server/endure/v2"
	httpPlugin "github.com/roadrunner-server/http/v5"
	"github.com/roadrunner-server/logger/v5"
	"github.com/roadrunner-server/server/v5"
)

func run() error {
	configPath := ".rr.yaml"
	if len(os.Args) > 1 {
		configPath = os.Args[1]
	}

	container := endure.New(slog.LevelError, endure.GracefulShutdownTimeout(30*time.Second))
	if err := container.RegisterAll(
		&logger.Plugin{},
		&appLogger.Plugin{},
		&server.Plugin{},
		&httpPlugin.Plugin{},
		&configPlugin.Plugin{Path: configPath, Timeout: 30 * time.Second},
	); err != nil {
		return err
	}
	if err := container.Init(); err != nil {
		return err
	}
	failures, err := container.Serve()
	if err != nil {
		return err
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	select {
	case failure := <-failures:
		return fmt.Errorf("plugin %s: %w", failure.VertexID, failure.Error)
	case <-signals:
		return container.Stop()
	}
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
