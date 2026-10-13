package main

import (
	"fmt"
	"os"
	"syscall"
)

func main() {
	if os.Getuid() != 0 || os.Geteuid() != 0 || os.Getgid() != 0 || os.Getegid() != 0 {
		panic(fmt.Sprintf("kernel root credentials mismatch: uid=%d euid=%d gid=%d egid=%d", os.Getuid(), os.Geteuid(), os.Getgid(), os.Getegid()))
	}
	groups, err := os.Getgroups()
	if err != nil || len(groups) != 0 {
		panic(fmt.Sprintf("kernel supplementary groups mismatch: groups=%v err=%v", groups, err))
	}
	if err := syscall.Setgroups([]int{20, 30}); err != nil {
		panic(err)
	}
	groups, err = os.Getgroups()
	if err != nil || len(groups) != 2 || groups[0] != 20 || groups[1] != 30 {
		panic(fmt.Sprintf("supplementary group update mismatch: groups=%v err=%v", groups, err))
	}
	if err := syscall.Setresgid(1001, 1002, 1003); err != nil {
		panic(err)
	}
	if err := syscall.Setresuid(1004, 1005, 1006); err != nil {
		panic(err)
	}
	if os.Getuid() != 1004 || os.Geteuid() != 1005 || os.Getgid() != 1001 || os.Getegid() != 1002 {
		panic(fmt.Sprintf("changed kernel credentials mismatch: uid=%d euid=%d gid=%d egid=%d", os.Getuid(), os.Geteuid(), os.Getgid(), os.Getegid()))
	}
	fmt.Println("GO CREDENTIALS PASS")
}
