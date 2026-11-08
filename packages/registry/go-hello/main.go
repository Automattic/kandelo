package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) != 2 || os.Args[1] != "package" {
		panic("expected package argument")
	}
	fmt.Println("GO PACKAGE PASS")
}
