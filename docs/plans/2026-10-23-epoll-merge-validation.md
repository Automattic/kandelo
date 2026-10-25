# Epoll, libevent and tmux merge validation

This records the final integration with main after the earlier
[epoll validation history](2026-10-20-epoll-validation.md),
[libevent comparison](../libevent.md), and [tmux acceptance](../tmux.md).
Dates in the logs are UTC; work began on October 22 in the local timezone.

## Source and build provenance

The initial implementation was committed as `7d8640d2d0`. Integration
commit `06cf49a9b08f` merges main at
`f602474ed4eb1f2d43befeda57e4562592ac901b`, preserving all five newer main
commits and their authorship. Three conflicts required resolution:

- PTY input is translated once before observing buffer changes for epoll
  notifications. Ignored input returns before producing a notification.
- Main's framebuffer binding release helper remains in place. Epoll wait
  leases are retired separately on exec and exit.
- Shell revision 55 combines tmux with main's lazy PHP 8.5.12, Composer,
  and certificate composition. It retains the ABI-51 floor.

The standalone resolver bundle was regenerated because main changed its
TypeScript inputs. Its reproducibility check passed. The normal SourceOnly
build uses the shared default source cache and the worktree's
`local-binaries/source-only-v1` projection; no alternate package/runtime
implementation or compatibility restamping was used.

The full build passed in 31m38s: all 194 nodes succeeded, with 178 cached
and 16 published. A refresh after resolver regeneration passed all 194
nodes from cache. Logs are `.context/merge-full-build.log` and
`.context/merge-projection-refresh.log`.

## Validation results

All commands run through `scripts/dev-shell.sh`. The sequential runner
sets `CI=1`. SourceOnly consumer and browser checks set
`WASM_POSIX_RESOLUTION_POLICY=source-only-v1` and the absolute
`WASM_POSIX_SOURCE_ONLY_BINARY_ROOT` for this worktree. The broad host
inventory uses its normal resolver environment so standalone local
fixtures remain enabled. This is local validation; no hosted CI result
is assumed.

| Check | Result | Evidence under `.context/` |
|---|---|---|
| Rust workspace, excluding separately tested xtask | 2,943 passed; zero failed/ignored | `merge-rust.log` |
| xtask | 718 unit tests and six integration tests passed | `merge-xtask.log` |
| ABI | ABI 51, snapshot and generated bindings consistent | `merge-abi.log` |
| Standalone resolver | Regenerated; reproducibility/load check passed | `merge-resolver-check.log` |
| Host build and declaration type check | Both passed | `merge-host-{build,typecheck}.log` |
| Browser unit tests | 204 passed; zero skipped/failed | `merge-browser-unit.log` |
| Artifact closures | 98 complete; zero incomplete/failed; eight outside the selection not built | `merge-closure-preflight.log` |
| SourceOnly browser asset audit | All 146 imports resolved; nine memory64 fixtures and Pages-size check passed | `merge-browser-assets.log` |
| Focused Node runtime | 43 SourceOnly tests plus both standalone fixture tests passed, covering all 45 selected cases | `merge-node-focused.log`, `merge-node-local-fixtures.log` |
| libc functional/regression | 121 PASS, three XFAIL, one FLAKE-PASS; zero unexpected failures | `merge-libc.log` |
| Selected POSIX signal interfaces | All 33 passed; zero failed/skipped | `merge-posix.log` |
| Sortix runtime | 416 PASS, 13 XFAIL, two SKIP; zero unexpected/build/timeout failures out of 431 | `merge-sortix.log` |
| Ordinary canonical rootfs | Rebuilt; complete lazy closure passed production size/integrity preparation | `merge-canonical-rootfs-match.log` |
| Ordinary example resolver | All seven tests passed after canonical image refresh | `merge-run-example-default.log` |
| Full ordinary host inventory | 5,271 passed, eight failed, 21 skipped across 568 files; all eight failures reproduced on current main | `merge-host-full.log` |
| Resource-isolated host cases | All three passed in separate processes | `merge-host-resource.log` |
| Focused browser runtime and UI | All 135 passed across Chromium, Firefox and WebKit | `merge-browser-focused.log` |
| Full Chromium smoke inventory | 321 passed, nine failed, seven skipped; eight failures identical on main, one Freeciv timeout passed three unchanged repeats | `merge-browser-full.log` |
| Browser memory regression gate | All nine browser cases passed; 72 application launches; 162 host regressions and three teardown cases each on Node and Bun passed | `merge-browser-memory.log` |
| Public shell entry point | All 21 tmux/theme cases passed across the three engines against a fresh normal browser server | `merge-live-ui.log` |

The merged-tree validation queue is complete. Its overall exit status is
1 because the full host and Chromium inventories retain the failures
described below. The final memory gate itself passed. The exact local
command queue is `.context/merge-validation-host-browser.sh`; per-suite
results are recorded in `.context/merge-results.tsv`. No change-specific
deterministic failure was identified in these runs.

The first focused Node run passed 43 tests and skipped the standalone
framebuffer and older epoll-mask fixtures because SourceOnly excludes them.
Both artifacts were already built locally. The runner was corrected, and
both cases passed under the normal policy with zero skips. The broad host
inventory uses that same normal policy; the completed SourceOnly port
checks remain separate. An interrupted libc
run is retained as `merge-libc-interrupted.log` and is not counted as a
completed conformance run. No assertion or timeout was weakened.

The first ordinary host sweep exposed an older canonical image at
`host/wasm/rootfs.vfs.zst`. Ordinary `resolveRootfsArtifact()` selected it
before the fresh program-package image, so the isolated example runner
correctly rejected a recorded sudo size that differed from the current
executable. The same command passed on the pristine main checkout after
its canonical image preparation. The candidate sweep was interrupted,
the image rebuilt with `scripts/build-rootfs.sh`, and its complete lazy
closure checked through `prepareRunExampleRootfs` before restarting the
host inventory. The interrupted log is
`.context/merge-host-full-stale-rootfs.log`; it is not a completed host
result. No runtime fallback or size-validation exception was added.

## Reproduction commands

Enter `scripts/dev-shell.sh bash` from the repository root. Provisioning
and case-sensitive Sortix source requirements are in the
[validation guide](../agent-guidance/validation.md). The suite entry
points used here are:

```bash
export CI=1
export WASM_POSIX_RESOLUTION_POLICY=source-only-v1
export WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$PWD/local-binaries/source-only-v1"
bash scripts/run-local-build.sh
bash scripts/build-resolve-binary-bundle.sh
bash scripts/test-resolve-binary-bundle.sh
bash scripts/ci-run-test-suite.sh cargo-workspace
bash scripts/ci-run-test-suite.sh cargo-xtask
bash scripts/check-abi-version.sh
bash scripts/build-programs.sh
(cd host && npm run build && npm run typecheck)
(cd apps/browser-demos && npm run test:unit)
npx tsx scripts/check-artifact-closures.ts
bash scripts/ci-check-browser-assets.sh
bash scripts/ci-run-test-suite.sh libc functional-regression
bash scripts/run-posix-tests.sh sigprocmask sigsuspend sigpending sigtimedwait sigwaitinfo
env PARALLEL=4 bash scripts/ci-run-test-suite.sh sortix runtime
```

Run the ordinary image and host inventory without SourceOnly overrides:

```bash
env -u WASM_POSIX_RESOLUTION_POLICY -u WASM_POSIX_SOURCE_ONLY_BINARY_ROOT bash scripts/build-rootfs.sh
env -u WASM_POSIX_RESOLUTION_POLICY -u WASM_POSIX_SOURCE_ONLY_BINARY_ROOT bash scripts/ci-run-test-suite.sh vitest
env -u WASM_POSIX_RESOLUTION_POLICY -u WASM_POSIX_SOURCE_ONLY_BINARY_ROOT bash scripts/ci-run-test-suite.sh vitest resource-isolated
```

For browser runs, keep SourceOnly enabled, choose a new unused
`KANDELO_PLAYWRIGHT_PORT` for each run, and retain the normal
`reuseExistingServer: false` behavior under `CI=1`. The focused inventory
and broad Chromium inventory use these commands:

```bash
(cd apps/browser-demos && npx playwright test \
  test/epoll-semantics.spec.ts test/libevent.spec.ts test/tmux.spec.ts \
  test/tmux-shell.spec.ts test/theme-contrast.spec.ts \
  test/native-rootfs-lazy.spec.ts test/rootfs-inspection.spec.ts \
  test/boot-current-boundary.spec.ts test/coi.spec.ts \
  test/vfs-import-seal-boundary.spec.ts \
  test/wasm-gc-reference-transport.spec.ts test/wasm-trap-signal.spec.ts \
  test/worker-exit-trap.spec.ts --workers=1)
(cd apps/browser-demos && npx playwright test \
  --grep-invert "@slow|@trap-signal" --project=chromium --workers=1)
./run.sh test browser-memory
```

These are separate runs. The broad sweep preserves the CI smoke selection
and each test's deadline, while removing the earlier 20-minute aggregate
cap so the inventory can finish. The public-entry check instead points
its unchanged tmux/theme specs at the normal `./run.sh browser` server,
with `webServer` disabled in its private Playwright configuration and a
separate output directory. No staging-proxy environment variable is used
for that ordinary Vite URL.

## Pristine current-main comparisons

A separate detached worktree at the exact main commit above has no source
overlay. Its own ABI-50 SDKs, kernel, rootfs and Bash were prepared through
normal bootstrap and SourceOnly resolution, with the shared source cache.
The candidate's ABI-51 binaries were not used for these comparisons.

The previously known source/catalog checks were repeated there. Five
assertions still fail: stb-source's missing build sidecar, fixture consumer
ownership, two SDL_mixer recipe expectations, and gallery ordering. The
older shell-bridge mismatch now passes on this main commit. Log:
`.context/merge-main-known-host-failures.log`.

The initial comparison skipped the group-enumeration test because its
legacy rootfs file prerequisite was absent. After building that image
through `scripts/build-rootfs.sh`, the exact group test ran and failed on
its expected ordering/count while the guest itself exited successfully.
Log: `.context/merge-main-group-enumeration.log`.

Two further host failures were reproduced separately. The eSpeak package
source test expects the old inline `ZIP_STORED` implementation after main
refactored its archive recipe. Its eight source-only assertions ran with
seven passes and one failure, without guest setup; this does not establish
runtime archive determinism. Log: `merge-main-espeak-source.log`.

The WordPress admin test expects a bcrypt cost of 10 in its database hash
regular expression. Main's PHP 8.5 image uses cost 12, so the test throws
before booting a guest. The baseline built its own WordPress image through
the normal SourceOnly graph, then reproduced the same exception at the
same test line. Log: `merge-main-wordpress-admin.log`.

All eight candidate assertion details match these exact-main results,
recorded in `.context/merge-host-failure-comparison.json`. There were no
test-file load failures. The full inventory had 555 passing, seven failing
and six entirely skipped files. The baseline source worktree remains
clean; no assertion, timeout or implementation was changed to obtain
these comparisons.

The 21 host skips include optional proprietary ELF fixtures, legacy
examples with missing fixture aliases, and the opt-in WordPress editor
suite. A supplemental legacy mouse test was enabled by placing the
unchanged SDK-built `mousetest.wasm` at its expected `host/wasm/` path.
It reached its ready handshake but timed out waiting for injected packets
on both the candidate and pristine main. Main compiled and instrumented
its own ABI-50 fixture. Logs: `merge-mouse-integration.log` and
`merge-main-mouse.log`. This remains a failing host-input check, not a
passing device-delivery claim.

## Browser failure comparisons

The broad Chromium sweep found an Omarchy/ffplay desktop startup failure:
its compositor starts, but `BAR_WORKSPACE active=1` never appears within
the original four-minute readiness deadline. The exact same test on
pristine current main fails at the same assertion with identical terminal
output. The direct main run used its own source-built kernel and complete
shell closure. Evidence: `.context/merge-main-browser-regressions.log` and
`.context/merge-main-browser-results/`.

All six non-slow Omarchy desktop scenarios were then run on pristine
main. All six fail waiting for desktop service startup: the wallpaper
layer in the themed-desktop case, the Hyprland IPC listener in three
other cases, or `KCLIPD_READY` in the two host-clipboard cases. Every candidate error-detail block matches its main result
exactly, including terminal output. Together with ffplay, these account
for seven directly reproduced browser failures. Evidence:
`.context/merge-main-omarchy.log`,
`.context/merge-main-omarchy-results/`, and
`.context/merge-browser-failure-comparison.json`.

The separate Wayland desktop scenario also fails on both trees waiting
for `CLIENT_CONNECTED count=3` after its compositor starts. Its complete
error details match exactly. Evidence: `.context/merge-main-wayland.log`
and `.context/merge-main-wayland-results/`. The comparison JSON therefore
contains eight identical current-main browser failures in total.

The two-client Freeciv network case initially timed out taking a terminal
screenshot during a display transition. That case passed on current main,
and all three unchanged candidate repetitions passed in 1m52s. Evidence:
`.context/merge-freeciv-repeat.log` and
`.context/merge-freeciv-repeat-results/`. The initial failure remains in
the full sweep's results; it is an intermittent observation, not a proven
main failure or a claim that the flake has been fixed.

The comparison runs use separate worktree caches and Playwright output
directories. No test expectation, per-case deadline, product setting or
guest behavior was changed.

The memory gate passed all nine browser cases with zero skips or flaky
results. Four Doom → Quake → Freeciv → LÖVE → tmux → WordPress cycles per
engine completed in a persistent page/audio realm: 72 application
launches across Chromium, Firefox and WebKit. Each tmux visit leaves its
server and two panes alive for normal machine teardown. The browser
portion took 10.1 minutes; the source ownership checks, 162 host
regressions, and three teardown cases each on Node and Bun also passed.
The complete log is `.context/merge-browser-memory.log` and its retained
browser results are `.context/merge-memory-results/`.

The public-entry acceptance run used `./run.sh browser` with only a
separate Vite cache directory, then ran the unchanged tmux shell and theme
specs with a separate Playwright output directory. All 21 cases passed in
1m14s. The real `/pages/kandelo/?profile=shell` flow covered pane/window
keyboard controls, detach/reattach, resizing, server exit, and rendered
status text contrast in all three engines. Its current screenshots are
`.context/tmux-{chromium,firefox,webkit}.png`; the Chromium image was also
visually inspected. This is automated browser and screenshot evidence,
not native Safari evidence. The user's original demo server was kept
running separately.

## Artifact identities

These products were selected through the normal SourceOnly resolver. The
full report, including both guest widths of the libevent backend/regress
programs and epoll syscall probes, is
`.context/merge-final-artifacts.json`. Tmux's executable bytes are
unchanged from the user-approved demo; the shell image also includes the
new main composition. All 11 recorded products/probes were verified
unchanged after the broad browser sweep; verification is recorded in
`.context/merge-final-artifacts-verified.json`. The regenerated standalone
resolver bundle has SHA-256
`bce565708a83f6cbcaa6838f6b41654eb120365b172e0901d5a7eac51d73bdf1`.

| Product | Bytes | SHA-256 |
|---|---:|---|
| Kernel | 1,434,205 | `93ca0385441ec98a077ef52ad8a7402ba64fdea6cb805b6e748e778698fce301` |
| Bash | 1,884,815 | `26050011bb787a30ccbe2fbcdb6bdb1efff84b410787be0c2aad4a9878cbeece` |
| Rootfs package | 171,836 | `608f4fb0b726981e7511b5ad71931748f57077e8d7f85e3bfe81854acab94e1e` |
| Shell image | 1,041,800 | `0d326063c627cc578029143f8be3e024f5ffeb85e0dfd96bfb9a7947f14b9ac9` |
| Tmux | 1,570,973 | `75167f75cbcf88f861639c247a0143cdfe3f4d0f27aef1e94e93ca28c40c05e1` |

## Scope

The [epoll behavior matrix](../epoll.md) remains the supported contract.
The older pinned-main libevent comparison and performance measurements
remain historical evidence at their recorded commits; they are not
measurements of this newly integrated tree. No performance improvement or
complete Linux compatibility claim is made.

Unmodified mio still requires target-selection support. Forked datagram
and KMS state-sharing gaps, absent epoll_pwait2, and custom-network-adapter
notification-history requirements remain documented. Full upstream
libevent/tmux regression inventories and native Safari were not run.
