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
