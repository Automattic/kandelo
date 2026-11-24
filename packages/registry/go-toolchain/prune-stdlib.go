// Drop standard-library sources whose file names select another platform.
package main

import (
	"go/build"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	if len(os.Args) != 2 {
		log.Fatal("usage: prune-stdlib <GOROOT/src>")
	}
	target := build.Context{
		GOOS:   "kandelo",
		GOARCH: "wasm32",
		// MatchFile applies the pinned toolchain's filename rules. Supply a
		// header without constraints so caller-specified build tags can still
		// enable any file whose name matches the target.
		OpenFile: func(string) (io.ReadCloser, error) {
			return io.NopCloser(strings.NewReader("package source\n")), nil
		},
	}
	err := filepath.WalkDir(os.Args[1], func(path string, entry fs.DirEntry, err error) error {
		if err != nil || !entry.Type().IsRegular() {
			return err
		}
		name := entry.Name()
		if strings.HasPrefix(name, "_") || strings.HasPrefix(name, ".") {
			return nil
		}
		switch filepath.Ext(name) {
		case ".go", ".s", ".syso":
			matches, err := target.MatchFile(filepath.Dir(path), name)
			if err != nil || matches {
				return err
			}
			return os.Remove(path)
		}
		return nil
	})
	if err != nil {
		log.Fatal(err)
	}
}
