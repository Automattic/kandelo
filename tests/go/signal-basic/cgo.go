//go:build cgo

package main

/*
int signal_from_c_thread(int signal);
int install_c_signal_handler(void);
int c_signal_handler_count(void);
int install_restart_handler(int fd);
*/
import "C"

import "syscall"
import "os"

func init() {
	foreignRestartSetup = func(fd int) {
		if C.install_restart_handler(C.int(fd)) != 0 {
			panic("cannot install C restart handler")
		}
	}
	foreignSignalProbe = func() {
		if status := C.signal_from_c_thread(C.int(syscall.SIGUSR1)); status != 0 {
			panic("C pthread could not raise its own signal")
		}
	}
	foreignHandlerProbe = func() {
		if C.install_c_signal_handler() != 0 {
			panic("cannot install C signal handler")
		}
		if err := syscall.Kill(os.Getpid(), syscall.SIGUSR2); err != nil {
			panic(err)
		}
		if C.c_signal_handler_count() != 1 {
			panic("Go syscall did not deliver C signal handler")
		}
	}
}
