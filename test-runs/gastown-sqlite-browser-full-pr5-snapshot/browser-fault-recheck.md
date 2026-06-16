# Browser SQLite Fault/Crash Recheck

Date: 2026-06-13
Branch: `polecat/coma/kad-wtb.11@mqbytir6`

This recheck used freshly rebuilt local artifacts after rebasing onto
`origin/main`:

```bash
scripts/dev-shell.sh bash -c 'bash build.sh'
scripts/dev-shell.sh bash -c \
  'bash packages/registry/tcl/build-tcl.sh &&
   bash packages/registry/zlib/build-zlib.sh &&
   bash packages/registry/sqlite/build-sqlite.sh &&
   bash packages/registry/sqlite/build-testfixture.sh &&
   bash images/vfs/scripts/build-sqlite-test-vfs-image.sh'
```

Important dev-shell note: use `bash -c`, not `bash -lc`. A login shell puts
Homebrew Cargo ahead of the Nix nightly toolchain and fails on the repo's
`-Z build-std`/`-Zunstable-options` settings.

## Isolated Browser Results

```bash
scripts/dev-shell.sh bash -c \
  'bash scripts/run-sqlite-official-tests.sh --host browser \
   --permutation full --jobs 1 --timeout-ms 900000 \
   --results-dir test-runs/kad-wtb.11-browser-sysfault sysfault.test'
```

Result: pass. `sysfault.test` completed 1 job, 1365 cases, 0 errors. The
snapshot's `sysfault-1.2.1-vfsfault-transient.27` and
`sysfault-1.2.2-vfsfault-transient.3` failures did not reproduce with rebuilt
artifacts.

```bash
scripts/dev-shell.sh bash -c \
  'bash scripts/run-sqlite-official-tests.sh --host browser \
   --permutation full --jobs 1 --timeout-ms 900000 \
   --results-dir test-runs/kad-wtb.11-browser-writecrash writecrash.test'
```

Result: fail. The prior snapshot failure at `writecrash-1.6.1` did not
reproduce, but the isolated browser run fails later:

```text
writecrash-1.52.1 expected: [0 {}]
writecrash-1.52.1 got:      [1 {couldn't execute "/usr/bin/testfixture": no such file or directory}]
```

This is browser-specific. The same rebuilt `testfixture.wasm` under the Node
host completed `writecrash.test` with 995 cases and 0 errors.

```bash
scripts/dev-shell.sh bash -c \
  'bash scripts/run-sqlite-official-tests.sh --host browser \
   --permutation full --jobs 1 --timeout-ms 900000 \
   --results-dir test-runs/kad-wtb.11-browser-walfault walfault.test'
```

Result: fail after about 6 minutes, not a silent hang. The failure is late in
the `walfault-9-oom-transient.*` sequence. The Tcl output ends with:

```text
UpdateStringProc should not be invoked for type (null)
Aborted
```

The browser console also reported a kernel trap while handling syscall 47
(`munmap`) for pid 102:

```text
[handleSyscall] kernel threw for pid=102 syscall=47 args=[180092928,32768,0,0,0,0]: RuntimeError: unreachable
```

The same isolated Node command did not hit this browser abort path before the
900000 ms outer timeout; its job remained `running` with no case errors in the
exported `testrunner.db`.

## Classification

The actionable browser set is now narrower than the original full-run snapshot:

- `sysfault.test`: passes in isolation with current rebuilt artifacts.
- `writecrash.test`: browser-only executable resolution/VFS visibility failure
  for `/usr/bin/testfixture` after repeated crash-child iterations.
- `walfault.test`: browser run reaches a late Tcl abort and browser kernel
  `munmap` trap; the snapshot's `running` state was an interrupted run, not the
  isolated terminal behavior.

Both remaining failures involve browser-only behavior under repeated child
process crash/abort paths. The next fix should instrument browser
`resolveExecutableForLaunch()`/`readFileFromFs()` and process teardown around
these tests to determine whether `/usr/bin/testfixture` is actually unlinked
from the shared VFS, hidden by path-resolution state, or missed because teardown
left the browser host with stale process/VFS metadata.
