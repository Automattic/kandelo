# Go second-M probe

This fixture proves only that a second Go runtime thread starts through
Kandelo's `kernel_clone` path, acquires its own channel, and writes a
marker. It does not exercise Go's scheduler on that thread.

Build the `kandelo-port` branch of
[`kandelo-dev/go`](https://github.com/kandelo-dev/go/tree/kandelo-port)
at commit `bad577d` with Go 1.25.6 as `GOROOT_BOOTSTRAP`. Keep its checkout
next to this Kandelo checkout as `../go-kandelo`.

From the Kandelo repository root:

```sh
scripts/dev-shell.sh bash scripts/check-abi-version.sh
mkdir -p .context/go-m2
(
  cd tests/go/second-m
  GOOS=kandelo GOARCH=wasm ../../../../go-kandelo/bin/go build \
    -o ../../../.context/go-m2/m2.wasm .
)
scripts/dev-shell.sh node --import tsx tests/go/second-m/run.ts \
  .context/go-m2/m2.wasm \
  target/wasm32-unknown-unknown/release/kandelo_kernel.wasm
```

The runner requires exit code 0, both M1 and M2 markers, and no host
diagnostics. The Go fork's eight-slot arena declaration is in the linked
binary; the runner uses the normal Node process-worker path with the
ABI-48 kernel built above.

The `../clone-handoff/` fixture requests five Go runtime threads in
sequence to exercise the child acknowledgment before the shared handoff
is reused. Build it from `tests/go/clone-handoff` with the same command,
choosing `.context/go-m2/multi.wasm` as output, then run the same Node
runner with `5` as its final argument. It asserts five child markers;
this is not a parallel goroutine or full-scheduler test.
