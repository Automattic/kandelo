# POSIX UDP Remaining Plan

Status: completed for the first POSIX UDP PR slice.

## Goal

Finish the first useful POSIX UDP PR by keeping UDP visible through the POSIX
socket API, treating host networking as a backend detail, and making the
current Sortix UDP coverage either pass or fail only for narrow documented
platform limits.

## Work Items

1. Fix UDP `connect(INADDR_ANY)` behavior. **Done.**
   - Decide behavior from kernel routing semantics, not from a browser or Node
     host shortcut.
   - Rerun `scripts/run-sortix-tests.sh udp connect-any-getsockname`.

2. Fix write-shutdown send behavior. **Done.**
   - Investigate SIGPIPE/EPIPE delivery ordering for UDP sends after
     `shutdown(SHUT_WR)` or `shutdown(SHUT_RDWR)`.
   - Prefer a syscall/signal ordering fix if the kernel is returning the right
     errno but the host observes the signal too early.
   - Rerun the affected shutdown-send UDP tests.

3. Classify external-network UDP tests. **Done.**
   - Keep loopback and in-kernel virtual datagram semantics POSIX-compatible.
   - Treat raw LAN/WAN/broadcast/cross-interface routing as intentionally
     unsupported until a HostIO proxy/relay backend exists.
   - If xfails are needed, list exact test names and document the reason.

4. Host test prerequisites. **Done.**
   - Rerun `cd host && npx vitest run` if `wat2wasm` is available.
   - If it is not available, leave an explicit prerequisite note instead of
     treating the suite as passed.

5. Verification. **Done.**
   - `cargo fmt --check -p wasm-posix-kernel`
   - `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`
   - Focused Sortix socket/API targets from the PR request.
   - `scripts/run-sortix-tests.sh udp`
   - Broader suites when practical.

## Done Criteria

- The UDP suite is runnable through both Sortix runner scripts.
- POSIX loopback UDP tests for bind, send/recv, connected receive filtering,
  source reporting, and poll readiness pass.
- Existing basic TCP/socket smoke tests do not regress.
- Remaining failures are either fixed or narrowly xfailed with a clear platform
  limitation and a next step.
- `docs/posix-status.md` matches the tested behavior.

## Results

- `scripts/run-sortix-tests.sh udp`: 196 pass, 13 exact xfail, 0 fail.
- `scripts/run-browser-sortix-tests.sh udp`: 196 pass, 13 exact xfail,
  0 fail.
- XFAILs are limited to raw external UDP route cases: LAN/WAN address
  selection, broadcast-with-`SO_BROADCAST`, cross-interface delivery, and one
  blackhole send after read shutdown.
- `cd host && npx vitest run test/virtual-network.test.ts
  test/virtual-network-e2e.test.ts`: 13 pass, 0 fail.
