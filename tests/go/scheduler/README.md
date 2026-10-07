# Go parallel-scheduler probes

These fixtures exercise the native `GOOS=kandelo` Go fork through the normal
Node process-worker and ABI-48 kernel path. Use the `kandelo-port` branch of
[`kandelo-dev/go`](https://github.com/kandelo-dev/go/tree/kandelo-port) at
commit `3fae0fa`, checked out beside this repository as `../go-kandelo`.
Build that fork with Go 1.25.6 as `GOROOT_BOOTSTRAP` first.

From this repository's root, with the ABI-48 kernel already built:

```sh
mkdir -p .context/go-m2
scripts/dev-shell.sh bash -c 'cd tests/go/scheduler && GOOS=kandelo GOARCH=wasm ../../../../go-kandelo/bin/go build -o ../../../.context/go-m2/scheduler.wasm .'
scripts/dev-shell.sh node --import tsx tests/go/scheduler/run.ts \
  .context/go-m2/scheduler.wasm \
  target/wasm32-unknown-unknown/release/kandelo_kernel.wasm
scripts/dev-shell.sh bash -c 'cd tests/go/scheduler && GOOS=kandelo GOARCH=wasm ../../../../go-kandelo/bin/go build -o ../../../.context/go-m2/exit-worker.wasm ./exit-worker'
scripts/dev-shell.sh node --import tsx tests/go/scheduler/run.ts \
  .context/go-m2/exit-worker.wasm \
  target/wasm32-unknown-unknown/release/kandelo_kernel.wasm \
  'worker M: exiting process'
```

The first program needs two Ms to make progress without a cooperative yield.
The second keeps the main M busy so `os.Exit(0)` runs on a worker M. Both
require exit 0, their expected marker, and no host diagnostics. They do not
prove browser behavior, concurrent clone contention, thread reaping, or full
Go runtime conformance.

`./concurrent-clone` is a separate probe for the clone handoff lock: in two
rounds, two scheduler Ms overlap and each requests a no-P M. Build it with
the same command using `./concurrent-clone`, then run the resulting Wasm with
the same Node runner and `parallel clone handoffs: complete` as its last
argument. It should emit four child markers with no host diagnostics. The
Chromium gate in `apps/browser-demos/test/go-port.spec.ts` also checks the
exact marker count.

`./locked-thread` verifies that `LockOSThread` binds its goroutine to one M
through scheduler yields and that `UnlockOSThread` clears the binding. Build
and run it like the other scheduler probes with
`locked worker affinity: complete` as the expected output. It does not
exercise terminating a locked thread whose goroutine exits without unlocking.
