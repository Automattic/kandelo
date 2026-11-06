# Go signal port validation observations

These are failed-run evidence, not expected-failure allowances.

- `sortix-node.json`: the combined signal/I/O run passed 88 cases, skipped
  two existing cases, and could not find one built fixture. The isolated
  `signal default-usr1-exec --sequential` rerun passed. An overlapping
  browser fixture build was canceled; run these builders sequentially.
- `sortix-browser-stale-rootfs.json`: all 34 executable cases failed before
  guest startup while loading the stale October canonical rootfs. After
  `scripts/dev-shell.sh bash scripts/build-rootfs.sh`, the complete browser
  signal rerun passed 34 cases with the same two existing skips.

Commands, source-log hashes, and nonpassing case identities are retained in
the generated JSON. The implementation log records the completed reruns.

`go-exec-sigquit.log` retains the failure lines from the first pure-Go
`os/exec` run. Before the fatal-diagnostic fix, SIGQUIT terminated by signal
instead of producing Go tracebacks and normal exit 2. The complete source
log SHA-256 is `7d501ebbc8f589f92fb18c7d5e7bc556ae45fa3ee8cc6b62f294e17959e26d1a`.
The subsequent three-test selection passes in both Go modes, including all
seven WaitInterrupt subcases. The source command is recorded in the
implementation log.

`go-browser-sync-compile.log` records two Chromium fixture errors from
the first 45-case safepoint run. The metadata assertion used synchronous
main-thread compilation above 8 MB. Its asynchronous-compilation correction
passes the full 45-case rerun. Source-log SHA-256:
`48e0bf792626ce540d7d8d321a51f50d985cfb614460a22696e33f52ab94c10f`.

`go-browser-waitid.log` records the Chromium upstream `os/exec` Unix-path
and wait probe failure in the rebuilt current-runtime browser inventory
(`go-core-current-runtime-1105-191504-61b5`). `TestWaitid` reports a child
exit status 1; guest stderr and host diagnostics are empty. This run has
146 passing cases and one failure. The same case passes in Firefox and
WebKit in that run; a subsequent three-repeat Chromium selection also
passes (`go-waitid-chromium-repro-1105-192258-4b84`). The result remains
intermittent, with no root cause established. A source-product build and
baseline provisioning were active during the main run.

Kandelo source commit: `663b4a472756`, with prepared WordPress test and
benchmark edits in the working tree. Go source: `29e2118`. Command:

```sh
scripts/dev-shell.sh bash -c 'set -e; bash tests/go/build-browser-fixtures.sh; cd apps/browser-demos; KANDELO_GO_BROWSER_TESTS=1 KANDELO_PLAYWRIGHT_PORT=5423 npx playwright test test/go-port.spec.ts --workers=1 --reporter=line'
```

Complete source-log SHA-256:
`5857215b9ba337ab9269daa246b0c30f97899c28518b7ac20c894f014ea04f9d`.

`go-browser-waitid-ebusy.log` retains decoded nonpassing stdout and stderr
from a 100-repeat Chromium upstream TestWaitid diagnostic run
(`go-waitid-upstream-diagnostics-1105-193531-d5e8`, exit 1). A Go test overlay
only adds child-error output and forwards that child's stderr; it changes
no runtime or installed standard-library implementation. The child reports
`read /dev/stdin: device or resource busy` after stop/continue. The
standalone pipe probes passed 200 rounds per Go mode in Node and Chromium;
the repeated upstream test supplies the actual failing sequence.

The overlay and exact browser fixture are retained locally under
`.context/waitid-upstream-debug/`; the invoked browser command is in that
job's log. Kandelo commit: `86204e23c`; Go fork: `29e2118`. The source build
and baseline package build were also active. Complete source-log SHA-256:
`b6101f9ef6ea1cdcbc772fa55992e58819aa9977de6853309b4bef0f031dc5bc`.

`stopped-read-before.log` retains the failure excerpt from `.context/stopped-read-retry-before.log`; complete source-log SHA-256: `5857c30da6037b33b7971dc1b22dec2b928ff727db156065141edd2923675dd8`.

`stopped-read-stale-source-check.log` retains the failure excerpt from `.context/stopped-read-retry-after.log`; complete source-log SHA-256: `d96a74da9a2f9abd3a883e0270ba411044a19c3f9c91554284c6f99d9827f862`.

The stopped-read tests fail with errno 16 in both wasm32 and wasm64 before
the host resume correction. The first four-file rerun then passes 184/185,
including both regressions, but an existing source-text assertion expects
the old libc wrapper's return syntax. Updating that assertion for typed
completion leaves its cancellation-point argument checks intact. The full
four-file rerun passes 185/185 with no skips. The diagnostic upstream
Chromium test also passes all 100 repeats with clean stderr after the fix.
These are corrected observations, not an expected-failure allowance.
