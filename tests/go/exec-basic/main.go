package main

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

const executable = "/bin/go-exec-basic.wasm"
const workDir = "/go-exec-work"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "child" {
		parent, err := strconv.Atoi(os.Getenv("GO_PARENT_PID"))
		if err != nil || parent != os.Getppid() {
			panic(fmt.Sprintf("wrong parent pid: got %d, want %d: %v", os.Getppid(), parent, err))
		}
		cwd, err := os.Getwd()
		if err != nil || cwd != workDir {
			panic(fmt.Sprintf("wrong child cwd: %q: %v", cwd, err))
		}
		if os.Getenv("GO_CHILD_MARKER") != "present" {
			panic("child environment missing")
		}
		if os.Getenv("GO_ISOLATED_CHILD") == "present" {
			group, err := syscall.Getpgid(0)
			if err != nil || group != os.Getpid() {
				panic(fmt.Sprintf("wrong child process group: got %d, pid %d: %v", group, os.Getpid(), err))
			}
		}
		fmt.Println("GO EXEC CHILD")
		os.Exit(7)
	}

	parent := os.Getpid()
	if parent <= 0 {
		panic(fmt.Sprintf("invalid parent pid %d", parent))
	}
	if err := os.Mkdir(workDir, 0o755); err != nil {
		panic(err)
	}
	for _, check := range []struct {
		path string
		args []string
		want syscall.Errno
	}{
		{path: "/bin/missing.wasm", args: []string{"missing"}, want: syscall.ENOENT},
		{path: "bad\x00path", args: []string{"bad"}, want: syscall.EINVAL},
		{path: strings.Repeat("a", 4096), args: []string{"long"}, want: syscall.ENAMETOOLONG},
		{path: executable, args: []string{strings.Repeat("a", 65536)}, want: syscall.E2BIG},
		{path: executable, args: []string{"bad-pgid"}, want: syscall.EINVAL},
	} {
		attributes := &syscall.ProcAttr{}
		if check.args[0] == "bad-pgid" {
			attributes.Sys = &syscall.SysProcAttr{Setpgid: true, Pgid: -1}
		}
		_, _, err := syscall.StartProcess(check.path, check.args, attributes)
		if err != check.want {
			panic(fmt.Sprintf("wrong launch error for %q: got %v, want %v", check.path[:min(len(check.path), 32)], err, check.want))
		}
	}
	_, _, credentialErr := syscall.StartProcess(executable, []string{executable}, &syscall.ProcAttr{
		Sys: &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 1001, Gid: 200}},
	})
	if credentialErr != syscall.ENOSYS {
		panic(fmt.Sprintf("unsupported child credentials: got %v", credentialErr))
	}
	env := []string{"GO_PARENT_PID=" + strconv.Itoa(parent), "GO_CHILD_MARKER=present"}
	process, err := os.StartProcess(executable, []string{executable, "child"}, &os.ProcAttr{
		Dir: workDir, Env: env, Files: []*os.File{os.Stdin, os.Stdout, os.Stderr},
	})
	if err != nil {
		panic(err)
	}
	state, err := process.Wait()
	if err != nil || state.Pid() != process.Pid || state.ExitCode() != 7 {
		panic(fmt.Sprintf("wrong child wait: state=%v pid=%d err=%v", state, process.Pid, err))
	}
	isolatedEnv := append(append([]string(nil), env...), "GO_ISOLATED_CHILD=present")
	isolated := exec.Command(executable, "child")
	isolated.Dir = workDir
	isolated.Env = isolatedEnv
	isolated.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pgid: 0}
	isolated.Stdin = os.Stdin
	isolated.Stderr = os.Stderr
	isolatedOutput, isolatedErr := isolated.Output()
	isolatedExit, isolatedExited := isolatedErr.(*exec.ExitError)
	if !strings.Contains(string(isolatedOutput), "GO EXEC CHILD") || !isolatedExited || isolatedExit.ExitCode() != 7 {
		panic(fmt.Sprintf("wrong isolated child output/wait: output=%q err=%v", isolatedOutput, isolatedErr))
	}

	command := exec.Command(executable, "child")
	command.Dir = workDir
	command.Env = env
	command.Stdin = os.Stdin
	command.Stderr = os.Stderr
	output, err := command.Output()
	exitError, ok := err.(*exec.ExitError)
	if !strings.Contains(string(output), "GO EXEC CHILD") || !ok || exitError.ExitCode() != 7 {
		panic(fmt.Sprintf("wrong command output/wait: output=%q err=%v", output, err))
	}
	fmt.Println("GO EXEC PASS")
}
