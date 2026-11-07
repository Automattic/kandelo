# Process signal listener ownership

This bounded source implementation uses the unchanged Node26.13.0
`internal/process/signal.js` over an actual native Signal owner. Its exact
source/commit identities and the conditional signal-name selection from
`node_constants.cc` live in `process-signals-sources.json`. The generator checks
these against the audited target. Signal values come from compiled guest
headers; no host-native values or platform identity are substituted.

`native-signals.cpp` installs an environment only at the actual main shell
entry. Worker entry points have no environment, independently of the JS
main/Worker policy. Real sigaction dispositions capture into a real nonblocking
CLOEXEC pipe using the portable `signal-owner.h`. The handler performs no JS,
allocation, user callback or ordinary mutex operation. Ordinary list mutations
block signals before acquiring the atomic gate, so the handler cannot interrupt
its own lock holder. Records carry the actual native owner cookie and signum.
Only successful writes advance caught counts. As in the pinned libuv handler,
pipe-full writes drop a signal; they never fabricate a queued event or liveness.

Main-loop dispatch retires each real record, including stale stopped/replaced
subscriptions, before callback dispatch. Native JS state owns roots, actual
async IDs/trigger/frame and SIGNALWRAP resource identity. Callback lookup happens
before the shared native callback scope. The close phase waits for caught and
dispatched counts to balance, then invokes the optional real callback and retires
the async ID/root. Main shutdown unregisters before the pipe can disappear and
never enters JS. Actual state/loop allocations have independent retained-memory
claims; kernel pipe capacity is not fabricated as native heap bytes.

Existing custom signal handlers (including engine/coverage handlers) are
preserved and subscription returns EBUSY. Safe engine/signal disposition sharing
is an implementation gap. This slice does not establish full signal or process
compatibility. Private terminal SIGWINCH registration, shell default-signal
policy and process.abort/status behavior, debugger interactions, fork
reinitialization, complete resource prototype/descriptor parity and guest/kernel
signal conformance still require work.

The focused controls execute actual POSIX delivery in an isolated native child
and compare the unchanged listener algorithm against the exact pinned native
Node Signal binding. The Worker control verifies JS activation policy; it does
not execute Kandelo Workers. These controls do not compile the SpiderMonkey
JSAPI fragment and are not guest or four-host conformance evidence. Run with
explicit `NODE26_REFERENCE` and isolated `SIGNAL_CONTROL_DIR` after the dev-shell
entry; there is no global setup, fixture provisioning or package build:

```
WASM_POSIX_DEV_SHELL_ATTEMPTS=1 scripts/dev-shell.sh env \
  NODE26_REFERENCE=/absolute/path/to/pinned/node \
  SIGNAL_CONTROL_DIR=/absolute/path/to/new/evidence \
  bash third_party/node-core/tests/process-signals/run-controls.sh
```
