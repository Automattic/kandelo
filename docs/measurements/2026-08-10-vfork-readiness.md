# ABI 43 vfork mechanism readiness — 2026-08-10

## Outcome

The mechanism gate passed at implementation commit
`334703abc` after production side-module replay was repaired in
`7a25d127b`. Follow-up gate hardening in `fee665caa` bounds every observation
to one named test run and one production dispatch, `d33cc6619` keeps allocator
measurement off the untraced runtime path, and `334703abc` cleans the compiled
side-module fixture after every success or failure. The gate observes ABI 43
mode 1 in the real Node and browser kernel-worker dispatch paths. It does not
infer the mechanism from a coordinator or allocator helper used in isolation.

The production observations show that mode 1 retains the parent's exact
`WebAssembly.Memory`, increases the alias count by one, and creates no full
process memory. The calling syscall remains pending until the child Worker
posts its exact `memory_quiescent` message and exact-generation teardown
finishes. Mode 0 is exercised through an ordinary guest `fork()` and observes
a distinct memory plus one live process-memory allocation.

This remains a **partial vfork mechanism**, not a claim of full POSIX
`vfork`. After `child_may_access_memory`, browser Worker termination does not
provide a portable exact fence proving that the Worker can no longer access
shared memory. Kandelo therefore retains loud status-139 whole-address-space
containment for ambiguous teardown. Timeout, delay, polling, Worker
termination, and JavaScript object reachability are not treated as
quiescence evidence.

| Gate | Status | Evidence |
| --- | --- | --- |
| Mechanism | PASS | Exact wrapper exited 0 at `334703abc` |
| Integration | PASS | Exact wrapper exited 0 at `9fe84cc44` on 2026-08-12 |
| Release | NOT RUN | Outside this mechanism-readiness task |

### Integration revalidation — 2026-08-12

`scripts/dev-shell.sh bash scripts/run-vfork-readiness.sh integration` passed
at `9fe84cc4420a98a25a9b64fccc6056a35917a9bd`. The gate rebuilt its guest
fixtures, ran 126 host checks in 18 files, ran the complete host-target
`fork-instrument` suite, ran the focused kernel credential set (12 passed),
and ran 42 Playwright checks across Chromium, Firefox, and WebKit.

The integration wrapper now invokes the workspace's actual kernel package,
`kandelo`, rather than its removed `wasm-posix-kernel` name. It covers
prepared target commit/failure, secure-exec and `nosuid` behavior, the
credential process record, exact caller-thread suspension, private borrowed
state, and ordinary-fork independence. The external compute-bound borrower
case still demonstrates whole-address-space containment in all browser
engines; it does not claim an exact portable external-kill quiescence fence or
safe parent resumption.

`ABI_VERSION` remains 43. No vfork import, fork mode, instrument-frame field,
memory-ownership protocol, safe-point architecture, or host protocol was
added. Ordinary fork mode 0 remains independent.

## Production-path evidence

`host/test/vfork-production-mechanism.test.ts` launches real
`NodeKernelHost` subprocesses. The trace is emitted by
`host/src/node-kernel-worker-entry.ts` only when the existing syscall-debug
switch is enabled. Allocator statistics are sampled only on that traced path;
a counting-source regression proves that mode 0 and mode 1 make no measurement
call when tracing is disabled. For every mode-1 child, the test observes:

```text
dispatch mode=1
vfork_prepared memory_identity=same live_memory_delta=0 alias_delta=1
child_may_access_memory
memory_quiescent
exact_teardown
parent_released
```

`memory_quiescent` is recorded only in the production listener handling the
exact message sent after `worker-main` returns. `parent_released` is recorded
only after the lifetime coordinator accepts that terminal evidence and exact
teardown completes. Test-only BEGIN/END delimiters partition output from each
fresh host. Within a run, each slice begins at a production `dispatch` and ends
at the next dispatch or run end. The shared parser rejects duplicate run names,
events outside a run, missing events, duplicate events, and reordered events.
Consequently, a reused PID or channel in a later host or dispatch cannot
satisfy an earlier vfork. It also observes different parent and child syscall
channels, owner-control and replay-prefix addresses, scratch storage, and
externref generations.

The same subprocess runs an instrumented program that calls ordinary
`fork()`. Production dispatch records `mode=0`, `memory_identity=distinct`,
and `live_memory_delta=1`; the guest also verifies that parent and child
memory mutations remain independent.

`apps/browser-demos/test/vfork-lifecycle.spec.ts` repeats both observations
through `BrowserKernel` on Chromium, Firefox, and WebKit. Each browser case
slices only the traces added during that case and applies the same
dispatch-bounded parser. Browser traces come from
`host/src/browser-kernel-worker-entry.ts` under the existing
`enableSyscallLog` setting and require every event, including
`child_may_access_memory`, with the same ordering and memory identity/count
assertions.

## Side-module and private-state evidence

The side-module fixture is compiled and fork-instrumented through the normal
toolchain. Its main module loads a real shared object, enters `vfork()` from a
side-module frame twice, verifies a preserved frame local in both continuations,
calls the loaded symbol in each child and parent, waits for each child, and
uses the loader again before `dlclose`.

Both Node and all three browser projects observe two production mode-1
dispatches for this fixture, same-memory borrowing, and distinct child syscall
channel, replay prefix, scratch workspace, and externref generation. The
child-private loader snapshot is materialized without writing the archive
owned by the parked parent.

The initial real fixture exposed a production defect: child status 6 followed
a Worker failure reporting that the borrowed child could not acquire the
dynamic-loader archive writer. Archive reconciliation was traced backward to
`__wpk_fork_module_state_table_reconcile`. The parent deliberately holds the
archive reader across its parked vfork syscall, while the child has already
materialized that exact immutable generation. Repair commit `7a25d127b`
therefore lets the borrowed child adopt and observe the immutable published
generation without acquiring the writer. Mutation entry points still require
the writer and remain forbidden.

The focused component tests for the lifetime coordinator, workspace,
continuation objects, and borrowed replay remain useful supporting coverage,
but they are not the evidence for production mode selection, memory identity,
quiescence ordering, or side-module dispatch.

The side-module fixture owns an idempotent cleanup handle. Node and browser
call sites invoke it in `finally`, and focused tests cover both ordinary cleanup
and partial-build failure cleanup. Repeated mechanism gates therefore do not
accumulate new repository-local fixture directories.

## Worker-start failure boundary

Production marks `child_may_access_memory` immediately before invoking the
deferred Worker factory. Therefore a Worker constructor/factory failure is
not a pre-borrow rollback state in the approved architecture. The gate injects
a one-shot failure at that real factory boundary on Node and browser and
observes:

- `worker_start_failed` strictly after `child_may_access_memory`;
- no child-generated `memory_quiescent`;
- no `parent_released` event or guest parent-resume marker;
- exactly one `vfork address-space containment` diagnostic; and
- process exit status 139 without a wedge.

Earlier setup failures can roll back before memory access, but no Worker has
been constructed at that point. The gate does not relabel a coordinator-only
completion as a pre-borrow Worker crash.

## POSIX and lifecycle evidence

The production guests cover main-thread and pthread callers, repeated calls,
rejected nesting/overlap, direct `_exit`, successful and failed `exec`, trap,
cooperative signal death, external kill, and exact `waitpid` reaping. The
pthread fixture observes its sibling continue running while only the calling
thread remains parked.

In `vfork-posix-state`, the child now reads state back after each mutation
before `_exit`: shared open-file-description offset, descriptor flags,
current working directory, process group and session/parentage, real and
effective group/user IDs, signal disposition, and signal mask. Only after all
readbacks succeed does it emit
`CHILD_CONFIRMED_PRIVATE_POSIX_MUTATIONS`. The parent then verifies that
descriptor-table, cwd, credential, process-group, signal-disposition, and
signal-mask mutations did not leak, while the shared open-file-description
offset did.

## Environment and artifacts

All commands ran through `scripts/dev-shell.sh`.

| Component | Observed version |
| --- | --- |
| Node.js | 24.15.0 |
| Chromium | 149.0.7827.55 |
| Firefox | 151.0 |
| WebKit | 26.5 |

| Artifact | SHA-256 |
| --- | --- |
| `local-binaries/kernel.wasm` | `ba9fda2e8ee45ee60048697577c46f80869494be77ccd4c499e6d5b175a3a946` |
| `vfork-lifecycle.wasm` | `1aac8d9f4d9f9ef8afd94a972b265026ee2c3f68f7944992b8217014d94d6f4c` |
| `vfork-from-thread.wasm` | `3f200ad015e262991ce8ece76a69325d50fb5f94da325f4846fb75873bbd2b1c` |
| `vfork-fatal-lifecycle.wasm` | `cfe13768fb204c486261ad78dbaf6203e12541576c612191a911d7bc6074724d` |
| `vfork-external-signal.wasm` | `87d6884830f0994e633a3bcc7ef502af4d13ee8990356ff81a8a3a05f148b49a` |
| `vfork-posix-state.wasm` | `97ff09e34ff33e1288679d6b6a56b46e15ccae971a7ce8e606eecec2140c0bd1` |
| `exec-child.wasm` | `9bd08d3cdd8db768af6162608df115b9ec9f73bc2a01ab69bcb53dab028f988f` |
| `fork-memory-clone.wasm` | `23f6ad1d41875c66693741a4f9c17aea517f933a28dd14b17fe2d48a01bfd306` |
| `vfork-side-main.wasm` | `44a03deef7aefa83205cbda489e93f9b8416ca83d5197d781cd484c029823fcf` |
| `libvfork-side.so` | `f426d4227aac1bad151aa6960f96dcb1950f75faa5bb37493cc3900db449dc52` |

The no-copy guest ceiling remains 16,973,824 bytes for each lifecycle,
pthread, fatal-lifecycle, external-signal, and POSIX-state parent. Successful
`exec` is tested separately because it legitimately creates replacement
program memory.

## Commands and observed status

The exact final gate command was:

```bash
scripts/dev-shell.sh bash scripts/run-vfork-readiness.sh mechanism
```

Status: exit 0 at `334703abc`.

- wrapper interface: PASS; both modes plus any extra argument returned the
  exact usage string and status 2;
- program build: PASS;
- host production build: PASS;
- Vitest: 14 files and 70 tests passed;
- complete host-target `fork-instrument` unit, integration, and doc-test
  suite: PASS; and
- Playwright: 36 tests passed across Chromium, Firefox, and WebKit.

The side-module production defect was reproduced with:

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && KANDELO_REQUIRE_SIDE_MODULE_FORK_E2E=1 npx vitest run \
    test/fork-from-dlopen-side-module-e2e.test.ts -t "mode-1 vfork"'
```

RED: one selected test failed with child status 6 and the archive-writer
prohibition. After `7a25d127b`, the focused regression plus its immutable
generation test passed two selected assertions.

Production observation and containment were checked with:

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npm run build && \
    npx vitest run test/vfork-production-mechanism.test.ts'
```

Status: PASS, two tests. The equivalent browser observations are part of the
36-test three-engine wrapper run.

Child POSIX readback was assertion-first. Before adding the child marker, the
focused lifecycle test failed because
`CHILD_CONFIRMED_PRIVATE_POSIX_MUTATIONS` was absent; after implementing all
readbacks it passed.

The generated package program index was regenerated because the affected
host-runtime sources participate in package build contexts, then verified:

```bash
scripts/dev-shell.sh bash -lc '
host_target=$(rustc -vV | sed -n "s/^host: //p")
target/$host_target/release/xtask build-deps program-index \
  --source-repo-root "$PWD" "$PWD/packages/registry" \
  "$PWD/packages/registry/program-packages.json"
target/$host_target/release/xtask build-deps program-index-context-check \
  --source-repo-root "$PWD"
'
```

Status: PASS.

No performance measurement was made and no performance claim is attached to
this correctness gate.
