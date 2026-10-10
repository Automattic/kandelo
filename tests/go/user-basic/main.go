package main

import (
	"fmt"
	"os"
	"os/user"
	"strconv"
)

func main() {
	current, err := user.Current()
	if err != nil || current.Uid != strconv.Itoa(os.Getuid()) {
		panic(fmt.Sprintf("current user: uid=%d gid=%d, %v, %v", os.Getuid(), os.Getgid(), current, err))
	}
	account, err := user.Lookup("runner")
	if err != nil || account.Uid != "1001" || account.Gid != "200" || account.HomeDir != "/home/runner" {
		panic(fmt.Sprintf("user lookup: %v, %v", account, err))
	}
	byID, err := user.LookupId("1001")
	if err != nil || byID.Username != account.Username {
		panic(fmt.Sprintf("user ID lookup: %v, %v", byID, err))
	}
	group, err := user.LookupGroup("staff")
	if err != nil || group.Gid != "200" {
		panic(fmt.Sprintf("group lookup: %v, %v", group, err))
	}
	groupByID, err := user.LookupGroupId("201")
	if err != nil || groupByID.Name != "workers" {
		panic(fmt.Sprintf("group ID lookup: %v, %v", groupByID, err))
	}
	groupIDs, err := account.GroupIds()
	if err != nil || len(groupIDs) != 2 || groupIDs[0] != "200" || groupIDs[1] != "201" {
		panic(fmt.Sprintf("supplementary groups: %v, %v", groupIDs, err))
	}
	if _, err := user.Lookup("missing"); err == nil {
		panic("missing user lookup succeeded")
	}
	fmt.Println("GO USER PASS")
}
