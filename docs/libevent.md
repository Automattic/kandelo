# Libevent

The registry provides libevent 2.1.12 for wasm32 and wasm64. The library
package installs static core, extra, combined, and pthread libraries, public
headers, relocatable pkg-config files, and the upstream license. OpenSSL
integration and upstream sample programs are disabled. DNS, HTTP, RPC,
buffers, and event-loop sources are compiled; this does not establish that
every upstream subsystem passes its tests on Kandelo.

[Tmux 3.8](tmux.md) is a wasm32 consumer of this package. It preserves
upstream's portable polling selection rather than forcing epoll.

Libevent discovers epoll through the SDK's headers and link probes. The
recipe does not define `__linux__`, patch upstream sources, or substitute a
poll/select backend. Its reusable library is separate from the
`libevent-tests` package. Consumers declare `libevent@2.1.12` and use the
resolver-provided `WASM_POSIX_DEP_LIBEVENT_DIR` include/library root.

## Build and exercise the port

From the repository root, build a minimal test projection including its
kernel. A selected local build replaces the projection's selected roots;
building the test package alone does not include a runnable kernel.

```bash
scripts/dev-shell.sh cargo xtask local-build run \
  --set packages/sets/local-supported.toml \
  --source-cache-root "$HOME/.cache/kandelo/source-only" \
  --output-root "$PWD/local-binaries/source-only-v1" \
  --product kernel --product libevent-tests --product libevent-tests64 \
  --jobs 4

scripts/dev-shell.sh bash -c '
  export WASM_POSIX_RESOLUTION_POLICY=source-only-v1
  export WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$PWD/local-binaries/source-only-v1"
  cd host
  CI=1 npx vitest run test/libevent.test.ts
'
```

The browser equivalent is `npx playwright test test/libevent.spec.ts
--workers=1` from `apps/browser-demos`, inside the dev shell with the same
absolute SourceOnly root and policy exported. Set `CI=1` and
`KANDELO_PLAYWRIGHT_PORT` to an available local port to start a fresh server.
The spec runs on Chromium, Firefox, and WebKit by default.

The regression executable compiles upstream's unchanged `test/regress`
sources and links the separately resolved library, then uses normal fork
instrumentation. The backend probe requires both `EV_FEATURE_ET` and
`EV_FEATURE_EARLY_CLOSE` and checks the actual selected backend. Tests cover
both ordinary epoll and `EVENT_EPOLL_USE_CHANGELIST=1`; a fallback backend
cannot turn missing epoll coverage into a passing run.

The selected upstream cases are the three `et/` cases and nine
`main/simpleclose` cases. They check callback counts, mixed edge/level
registration rejection, multiple events, close versus write shutdown, and
persistent and edge-triggered close events. Both host fixtures require all
12 cases to pass with zero skips. The complete upstream regression suite
is packaged but is not the scope of these fixtures.

## Related platform fix

Building the wasm64 regression runner exposed an invalid indirect call in
the generated `wpk_fork_resume_thread` wrapper. The shared instrumenter now
widens its unsigned host index for a table64 call while preserving its
existing export signature. Memory pointer width does not determine table
index width. The regression test validates all four width combinations;
this is a general build-tool fix, without a libevent-specific adaptation.

See [fork instrumentation](fork-instrumentation.md) and the
[epoll contract](epoll.md) for the platform behavior and remaining limits.

## Validation — 2026-10-22

The comparison uses the recorded main commit `89ed8af01e0b`, ABI 50, and
this branch's ABI-51 epoll implementation. Main received only the new
package recipes, matching test fixtures, and the same instrumenter fix;
the package ABI floors were adjusted to 50 there. Its kernel, libc, SDK,
and production host runtime remained at that recorded main commit. Each
side built its own libraries, guests, and kernel through SourceOnly.
This is a controlled overlay comparison, not an untouched checkout or a
test of later main commits.

Each configuration below means one architecture and one epoll mode. All
backend probes selected the requested epoll mode with features 11
(`ET | O1 | EARLY_CLOSE`). No upstream cases were skipped.

| Host | Configurations | Main result per configuration | This branch per configuration |
|---|---:|---:|---:|
| Node 24.15.0 | 4 | 2 passed, 10 failed | 12 passed |
| Chromium | 4 | 2 passed, 10 failed | 12 passed |
| Firefox | 4 | 2 passed, 10 failed | 12 passed |
| WebKit | 4 | 2 passed, 10 failed | 12 passed |

Main invokes the edge read callback twice where upstream expects one, and
does not deliver the eight `EV_CLOSED` close/shutdown cases. Its ordinary
read/write close case and libevent's mixed edge/level registration check
pass. The branch passes **192 upstream case executions** across these 16
configurations. The surrounding runner checks also require clean guest
stderr and host diagnostics, and no browser page errors.

The existing epoll guest probes passed separately: two Node cases and six
browser cases. The shared instrumenter's complete suite passed 388 tests,
including the new width regression. The final workspace Rust run passed
2,937 tests; package tooling passed 717 unit and six integration tests;
the ABI check passed. Exact jobs,
artifact hashes, setup failures, and the additional workspace check are in
the [epoll validation record](plans/2026-10-20-epoll-validation.md#libevent-integration--2026-10-22).

The complete libevent suite, downstream applications, and native Safari
were not run. Optional TLS integration is not built. These results prove
the selected event-loop behavior and the reusable package build; they do
not establish complete libevent or downstream-application compatibility.
