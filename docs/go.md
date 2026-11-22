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

The target uses cooperative preemption. The SDK smoke test on macOS ran
the same module on Node.js, Chromium, Firefox, and WebKit with the runtime's
default `GOMAXPROCS=1`. Constrained-memory profiles and larger workloads
remain unverified. Rebuild programs with the matching SDK after a program
ABI change.

## Validation

`tests/go/sdk-probe` is a standalone module that exercises goroutines and
GC, file I/O, loopback TCP, subprocess execution and SIGTERM delivery.
From the repository root in the SDK shell, prepare the browser products
and run the same executable on all four hosts:

```sh
./run.sh prepare-browser
export WASM_POSIX_RESOLUTION_POLICY=source-only-v1
export WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$PWD/local-binaries/source-only-v1"
export KANDELO_GO_SDK_PROBE="$PWD/.scratch/go-sdk-probe.wasm"
(cd tests/go/sdk-probe && wasm32posix-go build -trimpath -o "$KANDELO_GO_SDK_PROBE" .)
(cd host && npx vitest run test/go-sdk.test.ts)
(cd apps/browser-demos && npx playwright test test/go-sdk.spec.ts \
    --project=chromium --project=firefox --project=webkit --workers=1)
```

See [Go tools inside Kandelo](future-improvements.md#go-tools-inside-kandelo)
for the next milestone.
