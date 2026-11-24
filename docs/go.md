# Build and run a Go program

The experimental Go SDK builds pure-Go programs for `kandelo/wasm32` on a
development machine. The setup script checks out a pinned revision of upstream
Go and applies the [Go patches](../sdk/go/patches/) in order. The toolchain
version identifies the patched source tree. The compiler writes the program
ABI version and contract digest when it links, so build with the toolchain
pinned by the Kandelo checkout that will run your program.

Go executables use the existing Kandelo process and thread entry points. The
linker emits passive static data for the process initializer, and new Go threads
attach to that initialized memory through Kandelo's dynamic thread slots.

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

Both commands should print `Hello, Kandelo`.

## Build inside Kandelo

The Kandelo shell includes the experimental `go` command, its matching
compiler, assembler, and linker, and the standard-library sources for
`kandelo/wasm32`. Open the shell from `./run.sh browser`, then run these
commands at the Kandelo prompt.

```sh
mkdir -p "$HOME/go-hello"
cd "$HOME/go-hello"
export GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off CGO_ENABLED=0
go telemetry off
go mod init example.com/hello
cat > main.go <<'GO'
package main

import "fmt"

func main() { fmt.Println("Hello, Kandelo") }
GO
go build -p 1 -trimpath -o hello.wasm .
./hello.wasm
```

`go build` compiles the standard library on the first build. The cold build
took several minutes with `-p 1` on the development machine. Keep the build
cache between runs to reuse those outputs. Go needs writable temporary and
cache directories. Use `-p 1` to limit the number of simultaneous tool
processes.

The shell host loads the roughly 34 MiB Go archive on first use. For a
fully offline session, provide the shell image and the lazy assets the
commands use ahead of time. This quickstart uses `go.zip` and
`coreutils.wasm`, which provides `mkdir` and `cat`.

The example uses only the packaged standard library. An offline module
with extra dependencies needs those sources vendored or present in its
module cache. Use the packaged toolchain with `GOTOOLCHAIN=local`.

## Scope

The SDK selects `GOOS=kandelo GOARCH=wasm32` and disables cgo. Start with
pure-Go modules whose dependencies support this target. Modules with
OS-specific code can require a Kandelo port. The guest package covers
in-guest `go build` for `kandelo/wasm32`. Additional Go tools and automatic
toolchain switching are outside this iteration.

The Go scheduler defaults to `GOMAXPROCS=1`. Set `GOMAXPROCS` in the guest
environment or call `runtime.GOMAXPROCS` to adjust how many threads can run
Go code at once. The compiler inserts scheduler checks in user loops so a
call-free loop can yield for a pending scheduling or GC request. The
runtime still uses cooperative checkpoints. For comparison when profiling,
build with `GOEXPERIMENT=nopreemptibleloops` to disable the loop checks.

### Parallelism for embeddings

An embedding that has reserved a budget for a Go process can use
`goRuntimeEnv` from the SDK's `go-runtime-env.js` to prepare the process's
environment. The helper takes an explicit per-process budget and a host
hint, uses the smaller value and preserves any existing `GOMAXPROCS` entry.
With either input unavailable it chooses `1`. The embedding should account
for other guests and threads blocked in syscalls when setting that budget.

```js
import { goRuntimeEnv } from "wasm-posix-sdk/go-runtime-env.js";

const env = goRuntimeEnv(guestEnv, {
  hostHint: navigator.hardwareConcurrency,
  budget: 2,
});
await kernel.spawnFromVfs(programPath, [programPath], { env });
```

On Node.js, use `availableParallelism()` from `node:os` as the hint. CPU
hints estimate potential parallelism. Worker and memory limits still apply.
Rebuild programs with the matching SDK after a program ABI change.

## Validation

`tests/go/hello` is a minimal module for checking a normal `go build`.
`tests/go/sdk-probe` is a standalone module that exercises goroutines, GC,
thread startup and retirement, file I/O, loopback TCP, subprocess execution
and SIGTERM delivery. The matrix checks `GOMAXPROCS` values of `1`, `2`, and
`4`, a budgeted host default, and scheduler and GC progress during a
call-free loop at `1`.
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

The guest build acceptance test starts with an empty Go build cache, runs
`go build` in the shell, and runs the output in the same guest. It checks
that the guest invokes the packaged compiler, assembler, and linker and
that the result carries the kernel's program ABI contract.
The tests run on Node.js, Chromium, Firefox, and WebKit. With the source-only
build environment above, run them from the repository root:

```sh
(cd host && npx vitest run test/go-in-guest.test.ts)
(cd apps/browser-demos && npx playwright test test/go-in-guest.spec.ts \
    --project=chromium --project=firefox --project=webkit --workers=1)
```
