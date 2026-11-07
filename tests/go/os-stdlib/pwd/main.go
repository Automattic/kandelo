package main

import (
	"fmt"
	"os"
)

func main() {
	wd, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	fmt.Println(wd)
}
