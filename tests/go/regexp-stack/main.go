package main

import (
	"fmt"
	"regexp"
	"strings"
)

var repeated = regexp.MustCompile(`^www\.[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-z]+(?:[/#?][-a-zA-Z0-9@:%_\+.~#!?&/=\(\);,'">\^{}\[\]` + "`" + `]*)?`)

var protocol = regexp.MustCompile(`^(?:http|https|ftp)://[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-z]+(?::\d+)?(?:[/#?][-a-zA-Z0-9@:%_+.~#$!?&/=\(\);,'">\^{}\[\]` + "`" + `]*)?`)

func main() {
	if !repeated.MatchString("www."+strings.Repeat("a", 256)+".com") ||
		!protocol.MatchString("https://"+strings.Repeat("a", 256)+".com") {
		panic("counted repetition did not preserve its bounds")
	}
	fmt.Println("GO REGEXP PASS")
}
