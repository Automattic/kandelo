# Build and run a Go program

The experimental Go SDK builds pure-Go programs for `kandelo/wasm32` on a
development machine. It uses Kandelo's port of the upstream Go compiler and
runtime. The compiler writes the program ABI version and contract digest when
it links, so build with the toolchain pinned by the Kandelo checkout that will
run your program.

## Quickstart

From a Kandelo checkout with Nix, build the pinned compiler and enter the SDK
shell:

```sh
git submodule update --init --recursive
scripts/dev-shell.sh scripts/setup-kandelo-go.sh "$PWD/.scratch/go-sdk"
scripts/dev-shell.sh bash
export KANDELO_GO_ROOT="$PWD/.scratch/go-sdk/go"
wasm32posix-go version
```

The setup command expects a new directory. Use its printed
`KANDELO_GO_ROOT` for subsequent SDK shells.

In the same shell, save the repository path and create a module:

```sh
repo="$PWD"
mkdir -p "$repo/.scratch/go-example"
cd "$repo/.scratch/go-example"
wasm32posix-go mod init example.com/hello
cat > main.go <<'GO'
package main

import "fmt"

func main() { fmt.Println("Hello, Kandelo") }
GO
wasm32posix-go build -trimpath -o hello.wasm .
cd "$repo"
```

On Node.js, build the runtime and run the program with the example runner:

```sh
npm ci
./run.sh setup
npx tsx examples/run-example.ts "$repo/.scratch/go-example/hello.wasm"
```

For a browser, run `./run.sh browser` from the repository and open the
shell. [Send](../docs-site/guide/moving-files.md#bring-files-into-kandelo)
`hello.wasm` to it and execute the file from the guest terminal:

```sh
cd ~/Downloads
chmod +x hello.wasm
./hello.wasm
```

Both commands should print `Hello, Kandelo`. The standard shell image also has
a `go-hello` package built through the same pinned toolchain.

## Scope

The SDK selects `GOOS=kandelo GOARCH=wasm32` and disables cgo. Start with
pure-Go modules whose dependencies support this target. Modules with
OS-specific code can require a Kandelo port. The Go toolchain stays on the
development machine. Use Kandelo to execute the output of `go build`.

The target uses cooperative preemption. The intended initial coverage is
desktop Node.js and desktop browsers with the runtime's default
`GOMAXPROCS=1`. Treat constrained-memory profiles and larger workloads
as unverified. Rebuild programs with the matching SDK after a program ABI
change.

## Validation

`tests/go/sdk-probe` is a standalone module that exercises goroutines and
GC, file I/O, loopback TCP, subprocess execution and SIGTERM delivery.
Build it with the same SDK and pass the absolute artifact path as
`KANDELO_GO_SDK_PROBE` to `host/test/go-sdk.test.ts` and
`apps/browser-demos/test/go-sdk.spec.ts`. The browser tests take the same
file as the Node test.

See [Go tools inside Kandelo](future-improvements.md#go-tools-inside-kandelo)
for the next milestone.
