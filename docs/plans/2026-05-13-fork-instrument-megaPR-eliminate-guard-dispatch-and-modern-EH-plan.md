# Mega-PR: eliminate guard-dispatch + modern wasm-EH + comprehensive test program

**Date:** 2026-05-13
**Status:** Implementation mostly landed in **PR #307** (`fierce-wire` branch); remaining blockers are tracked in the phasing section below. Derived from `docs/plans/2026-05-13-fork-instrument-unsupported-cases-review.md` decisions for items A2, A3, A4, B1, B2, B3, B4, C3, C4, and C5.
**PR scope decision (2026-05-13):** After C1 and C2 reproductions showed B1 stages 1+2 don't actually close fork-from-catch end-to-end, the user directed that the architectural pivot and modern-EH flip land in PR #307 itself rather than as follow-up PRs — so that "fork from anywhere" (the PR's title) actually delivers. This expands #307's scope from the original "Phase 1–7 + B1 machinery" to "Phase 1–7 + B1 + eliminate guard-dispatch + modern wasm-EH + comprehensive test program." Estimated remaining work: ~6–10 weeks.
**Origin:** "No carve-outs" policy. The user's goal is `wasm-fork-instrument` that supports every fork-callable pattern unless physically impossible. After per-item review, the cleanest path is one large coordinated PR that pivots the dispatch architecture and flips the toolchain to modern wasm-EH simultaneously, with a comprehensive test program proving every supported case works.

## Scope

This PR bundles seven decisions into one coordinated change:

1. **Eliminate `guard-dispatch`** as a fallback scheme in `crates/fork-instrument/src/instrument.rs`.
2. **Runtime-dispatcher trampoline:** introduce a per-function (or per-module) post-call dispatch table so switch-dispatch can cover the residual cases that today force guard-dispatch (carryovers, irreducible CFGs, indirect calls).
3. **Modern wasm-EH SDK flip:** remove `-mllvm -wasm-use-legacy-eh=true` from `sdk/src/lib/flags.ts:11` and the 10 other call sites (`scripts/run-*-tests.sh`, `scripts/build-programs.sh`, `examples/libs/libcxx/build-libcxx.sh`, `examples/libs/lsof/build-lsof.sh`).
4. **libcxx rebuild & republish** with modern lowering. New `binaries-abi-v*` archive. Coordinate with all consumers.
5. **A2 — Multi-target `*_ref` try_tables:** extend the 6d rewrite stage to emit per-clause dispatch when a try_table has multiple `catch_ref` / `catch_all_ref` clauses pointing at different labels.
6. **A3 — Multi-target plain-catch try_tables:** extend B1 stage 2's single-target capture-block to per-target capture-blocks so multi-arm plain catches dispatch correctly on REWIND.
7. **A4 — Plain-catch arms with ref-typed operands (funcref/externref):** originally planned as per-arm auxiliary-table save/restore. Current PR decision: keep the safe `B1ScratchPlan::b2_carveout` path and cover it with WAT-level tests. Ordinary C++ EH is not expected to emit this shape, and no shipping port currently requires end-to-end A4 support.

Plus folded in per the 2026-05-13 user direction:

8. **C3 — fork-from-signal-handler:** add SIGUSR1/SIGALRM fixtures and verify existing direct + `call_indirect` closure discovers the handler paths. The broad "every address-taken function" rule proved redundant and was not added.
9. **C4 — fork-from-cancellation-cleanup:** add a `pthread_cleanup_push` fixture and host pthread-fork support so cleanup handlers running on pthread workers can fork and rewind through the saved thread entry.
10. **Flip existing `it.fails` tests to normal assertions.** `cpp_post_catch_fork_test` (C2) and `cpp_eh_fork_from_catch_test` (C1) currently land as `.fails` because the underlying fork machinery is broken in catch-handler-like contexts. When the architectural pivot makes them pass, flip back to normal `it(...)`.

Plus a load-bearing additional deliverable:

11. **Comprehensive instrumentation/rewind test program (`fork_instrument_coverage`)** that exercises every supported instrumentation pattern and rewind path. Co-located with `crates/fork-instrument/tests/` and built from C/C++ source via the SDK so it represents real toolchain output.

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
| C-08 | Plain catch arm whose operand is a `funcref`; WAT-level safe-carve-out coverage for unanticipated A4 shape |
| C-09 | Plain catch arm whose operand is an `externref`; WAT-level safe-carve-out coverage for unanticipated A4 shape |
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
| K-04 | Address-taken function passed to `qsort` comparator that conditionally calls `fork()` (pathological but proves indirect callback discovery) |

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

1. **Commit 1:** Land the test program scaffolding (driver + all D/C/S/K/P/F test IDs). Initially all pass cases are `#[ignore]` and all fail cases assert the current (pre-refactor) behavior. Establishes the regression contract.  ✅ landed as `c4ae805b0`.
2. **Commits 2–4:** Eliminate-guard-dispatch core. ✅ **Landed 2026-05-14 via sub-commits 2.1-2.6 + commit 3 + commit 4.** The trampoline approach in the original plan was replaced mid-execution with switch-dispatch extension (Option B carryover spilling, multi-value-params body-input-param prespill, Option<ValType> stack tracking). Commit 3 (`06dac02c4`) replaced the two `instrument_one_function_guard_dispatch` callers with `panic!` defensive assertions. Commit 4 (`0a7c729d7`) deleted the 838-LoC guard-dispatch helper graph. D-05 through D-09 still un-ignored and passing via the switch-dispatch path. See `memory/fork-instrument-fierce-wire-paused-pending-423.md` for the full sub-commit sequence.
3. **Commits 5–6:** A2 (multi-target `*_ref` rewrite) + A3 (multi-target plain-catch capture-blocks). ✅ **No dedicated rewrite needed after the modern-EH flip.** C-06 and C-07 pass under the existing B1 + Phase 6 machinery once the SDK explicitly uses `-mllvm -wasm-use-legacy-eh=false`.
4. **Commit 7:** A4 funcref/externref aux table. ✅ **Dropped from this PR as unnecessary for current support.** Current aux tables cover ref-typed user locals plus exnref catch stashing. Plain-catch arms with funcref/externref operands remain a documented safe carve-out via `B1ScratchPlan::b2_carveout`; C-08/C-09 are WAT-level "does not panic / carves out safely" coverage, not end-to-end support. This is an unanticipated Wasm-level case rather than expected C++ EH output.
5. **Commit 8:** C3/C4 — fork-from-handler hardening. ✅ **C4/P-06 fixed via the wpk_fork equivalent of PR #468.** The host now carries `ForkFromThreadContext` from `addChannel(pid, offset, tid, fnPtr, argPtr)` through `onFork`, rewinds fork children from the calling thread's fork buffer, and enters the saved pthread function instead of `_start`. `centralizedThreadWorkerMain` drives `wpk_fork_unwind_begin` / `wpk_fork_state` / `wpk_fork_rewind_begin` around the pthread function. K-03 and P-06 are normal `it()` assertions. C3's broad address-taken discovery rule was dropped as redundant: K-01/K-02/K-04/K-07 pass via the current call-graph reach.
6. **Commit 9:** Modern wasm-EH SDK flip + libcxx rebuild + binaries-abi bump. ✅ **Landed 2026-05-14 as `67a7dba7c`.** Removed `-mllvm -wasm-use-legacy-eh=true` from 11 source-tree locations; bumped `examples/libs/libcxx/package.toml` revision 2→3 so CI's content-addressed cache rebuilds libcxx + libcxxabi + libunwind + all dependent C++ programs under modern EH. Kernel ABI unaffected. Broader verification deferred to PR CI per the user's policy.
7. **Commit 10:** Update `docs/fork-instrumentation.md`. ✅ **Landed 2026-05-14 via `5c6f63a7e`, `a781fa64e`, `d2dad5948`; refreshed again for P-06/K-03, A4 carve-out state, C3 discovery, and P-04.** P-04 now maps `/bin/sh` to the ABI-current `programs/sh.c` fixture in the host coverage test.
8. **Commit 11:** Update `docs/posix-status.md` fork-from-catch entry to "Full" + new ucontext/A5 wording. ✅ Fork-from-catch is now `Full` after the explicit modern-EH flip; A4 remains called out as not-yet-supported.

## Open design questions

1. **libcxx rebuild coordination.** *Open.* Does C5 need a special staging release, or follow the normal `package-management` flow? Normal flow is simpler but means downstream consumers see new sha and may need to opt in.
2. **Mixed-lowering compatibility window.** *Open.* If a downstream user has older C++ artifacts built against legacy-EH libcxx and links against the new modern-EH libcxx, the ABI mismatch will break them. Do we ship both archives for a transition period, or cut over cleanly?
3. **Trampoline granularity.** ✅ **Resolved 2026-05-13: per-function dispatch tables.** Each instrumented fork-path function emits its own `(table $<fn>_post_table funcref)` populated via `(elem)` with the extracted post-call functions for that fn. Entry-point REWIND check does `call_indirect $<fn>_post_table (type $resume_sig) (local.get $call_idx)`. Site IDs stay function-local and dense (already true today: switch-dispatch's `partition_body` walks left-to-right and assigns `call_idx ∈ 0..n-1`). **Rationale:** the per-function approach is locally self-contained (no module-wide site-ID assignment pass, no init function, no base-offset literal injection per fn) and `call_idx` already indexes the table directly. Per-module's only real win is consolidated per-site metadata (e.g. a sidecar debug-name table), which can be added later as a sibling per-module table without disturbing the per-function dispatch — easy migration if the need materialises. Tradeoff: N tables emitted instead of 1, but funcref tables are cheap (no overhead per entry beyond the funcref itself) and the wasm multi-table proposal is universally supported in our toolchain.
4. **Test program structure.** ✅ **Resolved 2026-05-13: vitest in `host/test/`** (decision recorded in commit 1's commit message). Matches existing C1/C2 fixture pattern; reuses `runCentralizedProgram` which already exercises real kernel + worker plumbing.

## Commit 2 sub-decomposition

Commit 2 of the mega-PR is the trampoline scaffolding — the largest single piece of mechanical work. Decomposed into bite-sized sub-commits (each independently buildable + tested) per the executing-plans-skill convention:

- **2.1 — Test fixtures + spec.** Land WAT fixtures under `crates/fork-instrument/tests/fixtures/trampoline/` exercising the four classification classes the trampoline must cover: nested-Loop call, nested-IfElse call, nested-TryTable call, top-level carryover, nested call_indirect. Plus a Rust spec module documenting the expected emission shape for each. No code changes to `instrument.rs`. Tests assert the fixtures parse + validate; new tests for trampoline emission are added but `#[ignore]` until 2.3 lands.
- **2.2 — `mod trampoline` skeleton.** Add `crates/fork-instrument/src/instrument/` directory (move `instrument.rs` → `instrument/mod.rs`, create `instrument/trampoline.rs`). Re-export the existing public surface unchanged; new `pub(crate) fn emit_trampoline_dispatch(...)` stub that does nothing. Wire a new `instrument_one_function_trampoline_dispatch(...)` that delegates to `instrument_one_function_guard_dispatch(...)` (placeholder so existing tests stay green). Confirms the file-structure refactor is invisible.
- **2.3 — Per-function table emission.** Implement `emit_per_function_post_table(...)`: given a function and its `n` extracted post-call sites, emit `(table $<fn>_post_table n funcref)` and `(elem)` populating it. Implement the entry-point REWIND `call_indirect` shape. Add a unit test that runs against the 2.1 fixtures and asserts the emitted module contains the expected table + elem + dispatch shape (use `wasmprinter` to compare WAT). Still no behavior change at the dispatch decision; trampoline is emitted but unreachable.
- **2.4 — Extend switch-dispatch to handle top-level carryovers (revised 2026-05-14).** Originally planned to wire top-level carryover to the trampoline, but a closer read of `emit_spill_args` (instrument.rs:1134) and `emit_post_call_via_local` (instrument.rs:1473) showed Option B's spill-args-first-then-pop-carryovers can be applied inside switch-dispatch's existing emission with a much smaller diff (~80-120 LoC vs ~300-500 LoC for a trampoline-based approach). Result: switch-dispatch absorbs the top-level carryover case directly; the `has_top_level_stack_carryovers` branch in `instrument_one_function:303-304` is removed (top-level carryover now routes to switch-dispatch); `instrument_one_function_trampoline_dispatch` stays unimplemented and reserved for 2.5/2.6 (genuinely impossible nested cases). The carryover spilling (Option B, decided 2026-05-14): at each fork-path call site with `n` carryover slots, after `emit_spill_args` pops the call's args off the stack, also pop the `n` carryover values into per-call carryover spill locals; at `emit_post_call_via_local`, reload the carryovers BEFORE reloading the args, so the call lands with `[carryover, args]` on the stack as the original code expected. Carryover spill locals are added to `frame_scalars` so they're saved/restored across UNWIND/REWIND via the existing frame io. D-08 stays `it()`; the regression assertion changes from "no `wpk_guard_*` markers" to "no `has_top_level_stack_carryovers` routing" (the original function's branch is gone). The trampoline scaffolding from 2.2-2.4b is unchanged and still gets used in 2.5/2.6.
- **2.5 — Wire nested call_indirect to trampoline.** Same pattern: route the nested-`call_indirect` case from guard-dispatch to trampoline. D-07 (`call_indirect` to fork-path callee) and D-09 (irreducible CFG via `select` over function pointers) flip mechanism. Confirms the trampoline handles cross-function dispatch correctly.
- **2.6 — Wire nested Loop/IfElse/TryTable to trampoline.** The hardest case — extracting a post-call block out of deep structured control flow. Sub-routes within `classify_nested_pattern`: `UnsupportedLegacyTry`, `UnsupportedMultiValueParams`, `UnsupportedCarryover` all get a trampoline path. D-05 (loop) and D-06 (try_table) flip mechanism.

After 2.6, every call site that previously routed to `instrument_one_function_guard_dispatch` now routes to `instrument_one_function_trampoline_dispatch`. Commits 3-4 in the original phasing become:

- **3 (formerly "commits 3-4 part 2"):** Cleanup pass — verify no callers of `instrument_one_function_guard_dispatch` remain; mark the function `#[allow(dead_code)]` and add a regression assertion in lib.rs that the function is unreachable.
- **4 (formerly "commits 3-4 part 3"):** Delete `instrument_one_function_guard_dispatch` and the ~840 lines of guard-dispatch helpers (`wrap_body_guard_dispatch`, `rewrite_calls_in_seq_guard_dispatch`, `emit_wrapped_call_guard_dispatch`, `emit_gated_non_fork_call`, `side_effect_shape`, `emit_gated_side_effect`, `inject_frame_io_guard_dispatch`, `CallWrapCtxGuardDispatch`). Delete the fork-from-catch panic at `instrument.rs:280-287`. C-02, C-04, C-10, C-11 flip from `it.fails()` to `it()`.

Net result: original "Commits 2-4" expand to "Commits 2.1-2.6 + 3 + 4" = 8 sub-commits. Estimated effort unchanged (~3-4 weeks total) but reviewable in 2-3 day chunks.

## Validation gate

The PR cannot merge until all of:

- `cargo test -p fork-instrument` passes — including every D/C/S/K/P/F tool-level fixture.
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
