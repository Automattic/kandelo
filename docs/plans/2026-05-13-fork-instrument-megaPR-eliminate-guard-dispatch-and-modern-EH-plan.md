# Mega-PR: eliminate guard-dispatch + modern wasm-EH + comprehensive test program

**Date:** 2026-05-13
**Status:** Plan committed; implementation pending. Derived from `docs/plans/2026-05-13-fork-instrument-unsupported-cases-review.md` decisions for items A2, A3, A4, B1, B2, B3, B4, and C5.
**Origin:** "No carve-outs" policy. The user's goal is `wasm-fork-instrument` that supports every fork-callable pattern unless physically impossible. After per-item review, the cleanest path is one large coordinated PR that pivots the dispatch architecture and flips the toolchain to modern wasm-EH simultaneously, with a comprehensive test program proving every supported case works.

## Scope

This PR bundles seven decisions into one coordinated change:

1. **Eliminate `guard-dispatch`** as a fallback scheme in `crates/fork-instrument/src/instrument.rs`.
2. **Runtime-dispatcher trampoline:** introduce a per-function (or per-module) post-call dispatch table so switch-dispatch can cover the residual cases that today force guard-dispatch (carryovers, irreducible CFGs, indirect calls).
3. **Modern wasm-EH SDK flip:** remove `-mllvm -wasm-use-legacy-eh=true` from `sdk/src/lib/flags.ts:11` and the 10 other call sites (`scripts/run-*-tests.sh`, `scripts/build-programs.sh`, `examples/libs/libcxx/build-libcxx.sh`, `examples/libs/lsof/build-lsof.sh`).
4. **libcxx rebuild & republish** with modern lowering. New `binaries-abi-v*` archive. Coordinate with all consumers.
5. **A2 — Multi-target `*_ref` try_tables:** extend the 6d rewrite stage to emit per-clause dispatch when a try_table has multiple `catch_ref` / `catch_all_ref` clauses pointing at different labels.
6. **A3 — Multi-target plain-catch try_tables:** extend B1 stage 2's single-target capture-block to per-target capture-blocks so multi-arm plain catches dispatch correctly on REWIND.
7. **A4 — Plain-catch arms with ref-typed operands (funcref/externref):** add a per-program auxiliary table with index-based save/restore so ref-typed catch operands survive the fork boundary.

Plus a load-bearing additional deliverable:

8. **Comprehensive instrumentation/rewind test program (`fork_instrument_coverage`)** that exercises every supported instrumentation pattern and rewind path. Co-located with `crates/fork-instrument/tests/` and built from C/C++ source via the SDK so it represents real toolchain output.

## Why one PR

Every component in (1)–(7) touches either the dispatch core (`instrument_one_function_*`) or the EH lowering path (`6d_rewrite`, `plan_b1_scratch`, B1 stages). Staging them as separate PRs would mean:

- The libcxx rebuild blocks every C++ program rebuild. Each separate PR would need its own libcxx-coordinated republish.
- A2/A3/A4 (catch-handler dispatch) and eliminate-guard-dispatch (REWIND body re-execution) share data structures: `B1ScratchPlan`, `CatchRegionPlan`, `RefLocalSlot`. Diffs in separate PRs would conflict.
- The validation surface (every shipping C++ port re-running its test suite) is the same regardless of how many PRs slice the work. A single PR pays the validation cost once.
- Risk: the mega-PR will be very large to review. Mitigation: structured commit history, each commit fully buildable, with the test program landing first so subsequent commits each show the test program continuing to pass.

## The comprehensive test program

`fork_instrument_coverage` is the regression gate. It is written in real C/C++ and built with the SDK so the wasm bytecode exercises the patterns LLVM actually emits. Per the user's directive — *"all supported cases of instrumentation and rewind. Do not leave anything out."*

### Required coverage matrix

Every cell of this matrix must have at least one test case that proves the instrumentation produces a working binary and the rewind path produces correct child behavior. Cases that the review doc marks as accepted limits (A1 ucontext, A5 wasm-GC refs) get **fail-graceful** tests that verify the tool either refuses to instrument or the program traps cleanly — never silent miscompilation.

#### Dispatch coverage

| Test ID | Scheme | Pattern |
|---|---|---|
| D-01 | switch-dispatch | Single top-level fork at function root |
| D-02 | switch-dispatch | Multiple top-level forks (3+) in same function, each reached on different conditional branches |
| D-03 | switch-dispatch nested | Fork inside `if` body |
| D-04 | switch-dispatch nested | Fork inside `block` body |
| D-05 | switch-dispatch trampoline | Fork inside `loop` body (today forces guard-dispatch; trampoline must cover it) |
| D-06 | switch-dispatch trampoline | Fork inside `try_table` body, not in catch handler |
| D-07 | switch-dispatch trampoline | Fork reached via `call_indirect` (function pointer in a vtable; today forces guard-dispatch) |
| D-08 | switch-dispatch trampoline | Fork in a function whose top-level call sites have stack carryovers (`*(sp+K) = call(...)`-style; today forces guard-dispatch) |
| D-09 | switch-dispatch trampoline | Fork in an irreducible CFG (computed goto via `select` over function pointers; today forces guard-dispatch if it appears) |
| D-10 | cross-function | Fork in callee `B`, caller `A` instruments correctly with post-call dispatch around `call B` |

#### Catch-handler resume coverage (B1 + A2 + A3 + A4)

| Test ID | Pattern |
|---|---|
| C-01 | C++ `try { fork(); } catch (int) { ... }` — fork inside `try`, no catch executes (parent + child both proceed) |
| C-02 | C++ `try { throw 1; } catch (int) { fork(); }` — fork inside catch handler (B1 plain catch, single arm) |
| C-03 | C++ `try { throw "x"; } catch (int) { ... } catch (const char*) { fork(); }` — fork in one of multiple plain-catch arms (B1 stage 2 multi-arm) |
| C-04 | C++ `try { throw_helper(); } catch (int) { fork(); }` where `throw_helper` throws from outside the instrumented region (B2 — formerly ungated; under switch-dispatch + trampoline, must just work) |
| C-05 | Modern EH `catch_ref` with single clause + fork in handler |
| C-06 | Modern EH multi-target `*_ref` try_table — multiple `catch_ref` clauses to different labels, fork in one (A2) |
| C-07 | Modern EH `try_table` with multi-arm plain catches branching to different labels, fork in one (A3) |
| C-08 | Plain catch arm whose operand is a `funcref` (A4 aux table — funcref) + fork |
| C-09 | Plain catch arm whose operand is an `externref` (A4 aux table — externref) + fork |
| C-10 | C++ `try { fork(); } catch (...) { fork(); }` — fork in both try body and catch handler in the same function |

#### Side-effect-during-rewind coverage (B1, B3, B4 elimination)

Under guard-dispatch these required explicit gating. Under switch-dispatch + trampoline the body doesn't re-execute, so these must "just work." Each test verifies the side effect is observable only once (on NORMAL), never duplicated or skipped due to REWIND replay.

| Test ID | Side effect during fork prologue |
|---|---|
| S-01 | `__atomic_fetch_add` on a shared variable before `fork()` (B1 atomic RMW) |
| S-02 | `atomic_notify` on a futex before `fork()` (B1 atomic notify) |
| S-03 | `__c11_atomic_compare_exchange_strong` before `fork()` (B1 compare-exchange) |
| S-04 | Filling a `funcref` table via `table.fill` before `fork()` (B3 table.fill) |
| S-05 | Copying within a `funcref` table via `table.copy` before `fork()` (B3 table.copy) |
| S-06 | `table.grow` before `fork()` (B3 table.grow) |
| S-07 | Direct call returning a non-nullable `funcref` before `fork()`, result consumed after fork (B4) |
| S-08 | `throw` from a callee outside the fork-path call graph, caught inside an instrumented try_table, fork in the catch handler (B2) |

#### Callback-registration fork roots (C3 + C4)

| Test ID | Pattern |
|---|---|
| K-01 | `sigaction(SIGUSR1, &handler, NULL)` where `handler` calls `fork()`; parent raises SIGUSR1, both parent + child paths verified |
| K-02 | `signal(SIGALRM, &handler)` where `handler` calls `fork()`; `alarm(1)` triggers; both paths verified |
| K-03 | `pthread_cleanup_push(&cleanup_handler, arg)` where `cleanup_handler` calls `fork()`; thread cancellation triggers; parent + child verified |
| K-04 | Address-taken function passed to `qsort` comparator that conditionally calls `fork()` (pathological but proves conservative rule) |

#### Process/threading patterns

| Test ID | Pattern |
|---|---|
| P-01 | `fork()` from main thread, no other threads |
| P-02 | `fork()` while another thread is blocked in `pthread_cond_wait` (parent must continue post-fork; child must wake correctly) |
| P-03 | `fork()` from inside a critical section (`pthread_mutex_lock` held); child inherits locked mutex per POSIX |
| P-04 | `popen("...", "r")` followed by `pclose()` (exercises fork+exec+pipe end-to-end) |
| P-05 | `posix_spawn()` — verifies the non-forking path is unchanged by the dispatch refactor |

#### Failure-mode (accepted-limit) coverage

These tests prove that **accepted limits fail gracefully** — either the tool refuses to instrument with a clear error, or the program traps cleanly at runtime.

| Test ID | Pattern | Expected outcome |
|---|---|---|
| F-01 | Program calls `getcontext()` / `setcontext()` (A1) | Build succeeds (no fork-instrument involvement); runtime returns ENOSYS or similar. Trap not silent miscompilation. |
| F-02 | Program uses `makecontext()` / `swapcontext()` (A1) | Same as F-01 |
| F-03 | Program uses a wasm-GC reference type (`anyref`, `eqref`) on the fork path (A5) | `wasm-fork-instrument` exits non-zero with a clear error message naming the function and ref type. No partial output. |
| F-04 | Program uses a concrete GC reference (struct.new of a defined type) on the fork path (A5) | Same as F-03 |

### Test driver

`crates/fork-instrument/tests/coverage.rs` builds `fork_instrument_coverage` from source as part of `cargo test`, runs each test case end-to-end (fork + verify parent+child behavior), and reports pass/fail per ID. Failure modes (F-01..F-04) are verified by `assert_eq!(exit_code, expected_trap_code)` or by asserting the build itself fails with the expected error message.

## Implementation phasing within the mega-PR

The PR's commit history is structured so each commit is independently buildable and each test addition can be run against the implementation that follows.

1. **Commit 1:** Land the test program scaffolding (driver + all D/C/S/K/P/F test IDs). Initially all pass cases are `#[ignore]` and all fail cases assert the current (pre-refactor) behavior. Establishes the regression contract.
2. **Commits 2–4:** Eliminate-guard-dispatch core (extend `classify_nested_pattern`, implement runtime-dispatcher trampoline, delete `instrument_one_function_guard_dispatch`). D-05 through D-09 un-`ignore` and pass.
3. **Commits 5–6:** A2 (multi-target `*_ref` rewrite) + A3 (multi-target plain-catch capture-blocks). C-06 and C-07 un-`ignore` and pass.
4. **Commit 7:** A4 funcref/externref aux table. C-08 and C-09 un-`ignore` and pass.
5. **Commit 8:** Modern wasm-EH SDK flip + libcxx rebuild + binaries-abi bump. cpp_throw_test, vim, mariadb, php, quickjs all rebuilt. C-05 onwards exercise the new lowering.
6. **Commit 9:** Update `docs/fork-instrumentation.md` — delete §*Not guaranteed* lines 728–746 (multi-target `*_ref`, multi-target plain-catch, ref-typed catch operand carve-outs all gone); delete §*Not-yet-gated side effects* (B1–B4 gone); update §*Dispatch schemes* (guard-dispatch removed).
7. **Commit 10:** Update `docs/posix-status.md` fork-from-catch entry to "Full" + new ucontext/A5 wording. Update review doc with implementation-complete cross-references.

## Open design questions (must be resolved before implementation starts)

1. **libcxx rebuild coordination.** Does C5 need a special staging release, or follow the normal `package-management` flow? Normal flow is simpler but means downstream consumers see new sha and may need to opt in.
2. **Mixed-lowering compatibility window.** If a downstream user has older C++ artifacts built against legacy-EH libcxx and links against the new modern-EH libcxx, the ABI mismatch will break them. Do we ship both archives for a transition period, or cut over cleanly?
3. **Trampoline granularity.** Per-function or per-module dispatch table? Per-function is simpler but emits more code (each function has its own table); per-module is more compact but requires coordinating site IDs across the module.
4. **Test program structure.** Does `fork_instrument_coverage` live in `crates/fork-instrument/tests/` (Rust-driven, single binary per test) or in `host/test/` (vitest-driven, can mix Node and browser hosts)? The former is faster for the instrument-tool side; the latter exercises real host paths.

## Validation gate

The PR cannot merge until all of:

- `cargo test -p wasm-fork-instrument` passes — including every D/C/S/K/P/F test ID in `fork_instrument_coverage`.
- `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib` passes.
- `cd host && npx vitest run` passes — including `cpp-throw-test.test.ts` rebuilt under modern EH.
- `scripts/run-libc-tests.sh` 0 unexpected failures.
- `scripts/run-posix-tests.sh` 0 FAIL.
- `scripts/run-sortix-tests.sh --all` 0 FAIL, 0 XPASS.
- Every shipping C++ port (vim, mariadb, php, quickjs, cpp_throw_test, fbdoom) rebuilds and runs its existing test suite under modern EH lowering.
- `bash scripts/check-abi-version.sh` exits 0 — ABI bump correctly recorded.
- Benchmark: 3-round Node + browser benchmark vs main shows fork-heavy suites (process-lifecycle, erlang-ring, wordpress) within ±5% of post-Path-A baseline. Faster is acceptable.

## Related documents

- `docs/plans/2026-05-13-fork-instrument-unsupported-cases-review.md` — the review doc where each decision originated.
- `docs/fork-instrumentation.md` — current implementation guide; will be heavily revised in commit 9.
- `docs/plans/2026-04-22-fork-instrument-switch-dispatch-redesign.md` — Path A's prior plan; this PR extends Path A's approach.
- `docs/plans/2026-04-28-fork-instrument-b1-fork-from-plain-catch.md` — B1 stages 1+2 already landed; this PR extends to multi-target (A3).
- `docs/abi-versioning.md` — process for the binaries-abi bump.
