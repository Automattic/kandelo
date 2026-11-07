package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"regexp/syntax"
	"runtime"
	"time"
)

var sink *syntax.Prog

func main() {
	cases := map[string]string{
		"literal": "a", "literal-text": "hello, world!", "class": `[A-Z][a-z0-9_]+`,
		"capture": `(a+?)(b|c)*?`, "bounded-lazy": `(a*?){0,20}?`, "url": urlPattern,
	}
	name := os.Getenv("REGEXP_BENCH_CASE")
	if name == "" {
		name = "literal"
	}
	pattern, ok := cases[name]
	if !ok {
		panic("unknown benchmark case: " + name)
	}
	re, err := syntax.Parse(pattern, syntax.Perl)
	if err != nil {
		panic(err)
	}
	re = re.Simplify()
	compile := func() {
		var err error
		sink, err = syntax.Compile(re)
		if err != nil {
			panic(err)
		}
	}
	coldStart := time.Now()
	compile()
	coldNs := time.Since(coldStart).Nanoseconds()
	checksum := fmt.Sprintf("%x", sha256.Sum256([]byte(sink.String())))
	run := func(n int) time.Duration {
		start := time.Now()
		for i := 0; i < n; i++ {
			compile()
		}
		return time.Since(start)
	}
	n := 1
	elapsed := run(n)
	for elapsed < 10*time.Millisecond && n < 1<<24 {
		n *= 2
		elapsed = run(n)
	}
	n = int(int64(n) * int64(100*time.Millisecond) / int64(elapsed))
	if n < 1 {
		n = 1
	}
	if n > 1<<24 {
		n = 1 << 24
	}
	type sample struct {
		DurationNs int64
		TotalAlloc uint64
		Mallocs    uint64
	}
	samples := make([]sample, 0, 5)
	for range 5 {
		var before, after runtime.MemStats
		runtime.ReadMemStats(&before)
		elapsed = run(n)
		runtime.ReadMemStats(&after)
		samples = append(samples, sample{elapsed.Nanoseconds(), after.TotalAlloc - before.TotalAlloc, after.Mallocs - before.Mallocs})
	}
	result := struct {
		Name, GOOS, GOARCH, GoVersion, Checksum string
		N                                       int
		ColdNs                                  int64
		Samples                                 []sample
	}{name, runtime.GOOS, runtime.GOARCH, runtime.Version(), checksum, n, coldNs, samples}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		panic(err)
	}
}

var urlPattern = `^www\.[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-z]+(?:[/#?][-a-zA-Z0-9@:%_\+.~#!?&/=\(\);,'">\^{}\[\]` + "`" + `]*)?`
