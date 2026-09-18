# B52 — one confirmed fork regression, for lane F

**Status: OPEN. Scope narrowed 2026-09-17 — read this box first.**

Of the two defects below, **only the memory-retirement one is confirmed**.

The browser suite resolves artifacts differently depending on how it is
invoked, and nothing in the tree pins which mode is correct (B54).
Everything in this brief was first observed WITHOUT the source-only
policy the dev server uses. Re-run with it:

* `process-memory-retirement` fails identically in both modes. It is real
  and it is yours.
* `ruby-posix-spawn` **does not run** under source-only. Its fixture
  `exec-child.wasm` is not projected, so `artifactsAvailable` is false and
  both Ruby tests skip silently. The ENOMEM finding below stands only as
  an ambient-mode observation.

**Do not treat the Ruby item as a defect to fix yet.** It needs the
fixture-provisioning gap closed first so the spec can run in the
sanctioned mode; it may or may not reproduce there. Start with the
memory-retirement defect.

Read the withdrawal at the bottom first if you have the B50 brief in hand.

## What to fix

Two browser specs fail. Both reproduce alone, single-worker, on a tree
whose `./run.sh setup` exits 0 — so neither is flake, and neither is a
missing artifact.

Both fence process memory exactly. That is the only thing they share;
their symptoms are unrelated, and they may be two defects rather than
one.

### 1. `apps/browser-demos/test/ruby-posix-spawn.spec.ts:299`

"Ruby execs through vfork and root retains ordinary fork".

```
expect(rootResult.diagnostics).toEqual([])

- Expected  -  1
+ Received  + 12
+   Object {
+     "message": "fork aborted with errno=12: the kernel refused to create the child process",
+     "pid": 100,
+     "source": "fork",
+   },
+   ... the same object a second time
```

errno 12 is ENOMEM. The case runs as root (uid 0, gid 0) with
`maxProcessMemoryBytes: initialAddressSpaceBytes(rubyBinaryPath)` — the
address space fenced to exactly what the program starts with.

**The assertions before this one pass**: exit code 0, `stderr` empty,
and `RUBY_PRIVILEGED_FORK_MARKER` present in stdout. So root's ordinary
fork produces the correct result; what regressed is that it records two
aborted attempts on the way there.

Nothing is known about `childEvents` or `forkCounts` — lines 300-302
never run. An earlier version of this brief claimed those were wrong.
They were not measured.

### 2. `apps/browser-demos/test/process-memory-retirement.spec.ts:132`

"browser retires exact-fenced process memory across repeated fork and
exec". 100 iterations of fork+exec, fenced at 64 MiB.

```
expect(result.stdout.match(/child exited with 42/g)).toHaveLength(100)

Received has value: null
```

`null`, not a short array: **zero** occurrences.

**Line 129 passes**: `result.exitCodes` equals 100 zeros. So every fork
and every exec succeeds and reports success. The children's output never
reaches stdout. This is missing child output, not memory exhaustion —
do not start from the assumption that the fence is being hit.

## How to reproduce

```
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && \
  npx playwright test test/process-memory-retirement.spec.ts \
  --project=chromium --workers=1 --reporter=list'
```

Run each spec alone and single-worker. Running the ruby, memory and
merge-gate specs together starves them: three of four "failures" in one
such run were plain 180s/600s timeouts, and the memory spec's concrete
assertion was replaced by a timeout that says nothing. A timeout in this
area is a resource verdict, not a platform verdict.

## What is NOT in scope

The Node.js demo spec (`kandelo-merge-gate.spec.ts:331`) was listed here
as a third regression. It is not one, and it is not yours: it fails
because the optional-demo VFS images do not resolve under the
source-only policy, it predates the lane Y/V merge, and it is filed
separately as B54.

## Withdrawal: the B50 brief was wrong

**Discard the B50 brief. Lane F's code was never at fault.**

It blamed three lines of the fork-module injector for a `LinkError`
about the module's table import. That diagnosis was wrong, and it was
the third wrong diagnosis in a row: the module was internally consistent
(`wasm-tools dump` and the host's own parser both read `table_size: 2`),
and two rebuilds chasing leaked `LDFLAGS` and a leaked cross `LD`
produced a byte-identical error.

The actual cause was a stale `host/dist`: package-build workers run the
compiled bundle, which was a day older than `host/src`. Nothing in the
tree checks that bundle's freshness, which is filed as B51.

Apologies for the wasted time.
