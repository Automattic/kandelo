# Fork-instrument unsupported cases — review and plan

**Date:** 2026-05-13
**Status:** In review — items to be discussed one-by-one with the user; decisions to be appended as `**Decision:**` blocks per item.
**Origin:** Phase 7 + B1 cleanup. The user's goal is **no carve-outs** — `wasm-fork-instrument` should support every fork-callable pattern unless physically impossible.

This document inventories every place where `wasm-fork-instrument` rejects, carves out, partially supports, or leaves ungated a fork-relevant operation. Each item has an honest "is this actually impossible?" judgment and a rough effort estimate so the user can drive decisions about which to take on and which to accept as known limits.

The current authoritative state of unsupported patterns also lives in `docs/fork-instrumentation.md` §*Not guaranteed* and §*Not-yet-gated side effects*, and in the saved task list (`memory/fork-instrument-fierce-wire-paused-pending-423.md` items #14–#23). This doc consolidates and adds judgment.

---

## Category A — Patterns the instrumenter rejects or carves out

### A1. `makecontext` / `swapcontext` / `getcontext` / `setcontext`

- **Today:** Unsupported by design. `docs/fork-instrumentation.md:725` and `docs/posix-status.md:147` declare it out of scope. Saved task #21 flags re-examination.
- **Why:** The fork-instrument tool's call-graph analysis is rooted at the `kernel.kernel_fork` import. Supporting `setcontext()` requires generalising save/restore to arbitrary suspend/resume points, with the target frame possibly unrelated to the current fork-path. The save buffer becomes multi-context.
- **Impossible?** No — a generalisation of the fork-from-anywhere problem.
- **Effort:** Large. Probably 50–100% extra on top of the current fork-instrument: broader reachability (every function reachable from a `setcontext` call), per-program annotation of context-switch boundaries (since ucontext is library-mediated, the instrument tool can't auto-discover boundaries from the wasm alone), multi-context save buffer layout.
- **Decision:** _pending discussion_

### A2. Multi-target `*_ref` try_tables

- **Today:** Skipped at the 6d rewrite stage. `docs/fork-instrumentation.md:728-731`. No shipping program forces it because legacy-EH lowering is in use (see C5).
- **Why:** The 6d rewriter emits a single dispatch path for `catch_ref` clauses. Multiple `catch_ref`/`catch_all_ref` clauses pointing at different labels would need per-clause dispatch tables.
- **Impossible?** No.
- **Effort:** ~1–3 days. The design parallels B1 stage 2's multi-arm dispatch.
- **Decision:** _pending discussion_

### A3. Multi-target plain-catch try_tables

- **Today:** Detected and carved out by B1 stage 2 (`docs/fork-instrumentation.md:732-736`). The function is excluded from fork-path instrumentation rather than emit a half-correct dispatcher.
- **Why:** Multiple plain catches whose handlers branch to different labels need per-target capture-blocks. B1 stage 2 chose carve-out over the dispatcher to avoid silent miscompilation.
- **Impossible?** No.
- **Effort:** ~1–2 weeks. Extension of B1 stage 2 with per-target capture-blocks; includes fuzz oracle coverage.
- **Decision:** _pending discussion_

### A4. Plain-catch arms with ref-typed operands

- **Today:** Carved out at `instrument::plan_b1_scratch`. `docs/fork-instrumentation.md:737-742`. No shipping fork-path program forces it.
- **Why:** Spilling ref-typed catch operands to linear memory isn't legal (refs cannot be stored to linear memory). Would need a per-arm auxiliary *table* with index-based save/restore.
- **Impossible?** For funcref/externref: no, supportable with a dedicated aux table. For abstract GC refs: see A5.
- **Effort:** ~1 week for funcref/externref. Design + implementation + fuzz coverage.
- **Decision:** _pending discussion_

### A5. Wasm-GC refs (`any` / `eq` / `struct` / `array` / `i31`, concrete GC types)

- **Today:** Rejected with a panic at `classify_ref`. `docs/fork-instrumentation.md:743-746`. Anticipated by a future SpiderMonkey port.
- **Why:** Wasm-GC's reference model has no in-tool way to enumerate live refs across a fork boundary. The GC heap is host-managed; the instrument tool sees only the module bytes.
- **Impossible?** Today, effectively yes — without host-managed GC root pinning. The instrument tool alone cannot save/restore GC heap state.
- **Effort:** Multi-week + cross-cutting: a host-side GC root table API exposed to the kernel, plus coordination with whatever runtime hosts GC (SpiderMonkey, V8 GC, etc.). Likely deferred until a real GC-using program is in scope.
- **Decision:** _pending discussion_

---

## Category B — Side effects not gated during guard-dispatch REWIND

Guard-dispatch re-executes the body top-to-bottom on REWIND to reach the matching `kernel_fork` call. Phase 4g gates the common side-effect instructions (`local.set`, `local.tee`, `global.set`, `store`, `memory.{grow,fill,copy,init}`, `data.drop`, `elem.drop`, `table.set`). The instructions below are *not* gated; a fork-path program that hits them between the fork call and the unwind boundary may misbehave during REWIND. Switch-dispatch (when applicable) sidesteps all of these by skipping the prefix body entirely.

### B1. Atomic RMW and `atomic.notify`

- **Today:** Not gated. `docs/fork-instrumentation.md:777`.
- **Why:** Atomic ops have cross-process observability — a no-op REWIND replay would still hit the shared address but with stale reads. The "frame-save the result, conditional `state==NORMAL`" pattern doesn't preserve cross-process ordering.
- **Impossible?** Hard. Atomics have observable side effects beyond the calling process; correct gating requires recording the atomic value on NORMAL and replaying it on REWIND, plus careful ordering.
- **Effort:** ~1–2 weeks. Per-op design with cross-process semantics.
- **Decision:** _pending discussion_

### B2. `throw` / `throw_ref` outside instrumented regions

- **Today:** Not gated. `docs/fork-instrumentation.md:777`.
- **Why:** A throw from a non-fork-path function inside a fork-path try region is a control-flow side effect. The current gating reach is the fork-path call graph; throws from outside that reach aren't gated.
- **Impossible?** No — extend instrumentation reach. Indirect throws from uninstrumented libraries are harder.
- **Effort:** Medium. Depends on how much of the call graph we expand.
- **Decision:** _pending discussion_

### B3. `table.grow`, `table.fill`, `table.init`, `table.copy`

- **Today:** Not gated. `docs/fork-instrumentation.md:778`.
- **Why:** Tables don't have a single scalar slot to round-trip a result through; the standard gating shape doesn't directly apply.
- **Impossible?** No.
- **Effort:** ~3–5 days. Design + per-op gating scheme, similar in spirit to memory-op gating.
- **Decision:** _pending discussion_

### B4. Direct `Call` with non-nullable `Ref` return type

- **Today:** Not gated. `docs/fork-instrumentation.md:779-780`.
- **Why:** The frame-saved-result trick uses a scalar default (0); non-nullable refs have no zero value.
- **Impossible?** No, with caveats. Either skip-gate only when the result is consumed, or introduce a nullable mirror slot.
- **Effort:** ~1 week.
- **Decision:** _pending discussion_

---

## Category C — Partial / known-broken / blocking flips

### C1. B1 plain-catch fork — first real-world validation

- **Today:** B1 stages 1+2 shipped on this PR. No real-world C++ EH+fork program has exercised the machinery; cpp_throw_test only validates EH itself, not EH+fork.
- **Plan:** Stage 3 needs the SpiderMonkey port or a synthetic C++ EH+fork fixture under `host/test/cpp-throw-test.test.ts`. Deferred per `docs/plans/2026-04-28-fork-instrument-b1-fork-from-plain-catch.md`.
- **Decision:** _pending discussion_

### C2. Test (b) post-catch fork-hang root cause

- **Today:** Saved task #16 was "in_progress with workaround." Workaround (the partial revert of PR #434's worker-main.ts) was dropped during today's rebase. The architectural Path-A switch-dispatch fix that landed in Phase 7 may already cover it; needs a fresh repro to confirm.
- **Plan:** Re-run the SpiderMonkey spike's test (b) against post-rebase fierce-wire. If hang reproduces, investigate concretely. If not, mark resolved.
- **Decision:** _pending discussion_

### C3. fork-from-signal-handler

- **Today:** No fixture, no handling. Saved task #17.
- **Plan:** Extend call-graph discovery into registered sigaction handlers; treat them as fork-path roots. Add a fixture under `crates/fork-instrument/tests/` and an integration test that forks from a SIGALRM handler.
- **Effort:** ~1 week.
- **Decision:** _pending discussion_

### C4. fork-from-cancellation-cleanup

- **Today:** No fixture, no handling. Saved task #18.
- **Plan:** Identify `pthread_cleanup_push` registrants; treat as fork-path roots. Add a fixture + test.
- **Effort:** ~1 week.
- **Decision:** _pending discussion_

### C5. Modern wasm-EH SDK flip

- **Today:** `sdk/src/lib/flags.ts:11` sets `-mllvm -wasm-use-legacy-eh=true`. Same flag is hardcoded in 8 test/build scripts and 2 raw-clang build scripts (`examples/libs/libcxx/build-libcxx.sh:119`, `examples/libs/lsof/build-lsof.sh:54`). Saved task #14.
- **Why blocking:** Until flipped, items A2 + A4 are dormant — no shipping binary emits modern-EH patterns that would force them.
- **Plan:** Flip flag SDK-wide, rebuild libcxx with modern lowering, publish a new `binaries-abi-v*` archive, rebuild every C++ program that uses EH (cpp_throw_test, vim, mariadb, php, quickjs), audit fork-instrument behavior under modern-EH binaries.
- **Effort:** Multi-day. Likely its own PR rather than a Phase 7 cleanup item.
- **Decision:** _pending discussion_

---

## How to use this document

For each item, a decision falls into one of:

- **Now (this PR):** Add the work to fierce-wire / PR #307.
- **Next PR (named):** Open a follow-up PR / branch with a written plan doc and link from here.
- **Deferred (linked):** Add a one-line entry under `docs/future-improvements.md` and link from here.
- **Accept as known limit:** Document the constraint in `docs/fork-instrumentation.md` and `docs/posix-status.md`; close the question.

Update each item's **Decision:** block in this doc as we work through them. The doc is the source of truth for what was decided and why.
