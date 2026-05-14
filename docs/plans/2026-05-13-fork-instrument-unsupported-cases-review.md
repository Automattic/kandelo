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
- **Decision (2026-05-13):** **Accept as known limit.** The POSIX API is deprecated in POSIX.1-2008 and the major coroutine users (Erlang/BEAM, Ruby fibers, Python `greenlet`) already implement their own user-space context switching at the runtime level, bypassing libc's ucontext entirely. Existing documentation in `docs/posix-status.md` (the ucontext row under Wasm-Inherent gaps) and `docs/fork-instrumentation.md:725-727` is sufficient. Revisit only if a real program forces the issue.

### A2. Multi-target `*_ref` try_tables

- **Today:** Skipped at the 6d rewrite stage. `docs/fork-instrumentation.md:728-731`. No shipping program forces it because legacy-EH lowering is in use (see C5).
- **Why:** The 6d rewriter emits a single dispatch path for `catch_ref` clauses. Multiple `catch_ref`/`catch_all_ref` clauses pointing at different labels would need per-clause dispatch tables.
- **Impossible?** No.
- **Effort:** ~1–3 days. The design parallels B1 stage 2's multi-arm dispatch.
- **Decision (2026-05-13):** **Plan as prerequisite for C5.** A2 must land in the same PR as the modern wasm-EH SDK flip (C5) — without it, the flip would ship binaries with silently-carved-out functions whose fork-path catch handlers stop working. Bundle into the C5 plan doc when written.

### A3. Multi-target plain-catch try_tables

- **Today:** Detected and carved out by B1 stage 2 (`docs/fork-instrumentation.md:732-736`). The function is excluded from fork-path instrumentation rather than emit a half-correct dispatcher.
- **Why:** Multiple plain catches whose handlers branch to different labels need per-target capture-blocks. B1 stage 2 chose carve-out over the dispatcher to avoid silent miscompilation.
- **Impossible?** No.
- **Effort:** ~1–2 weeks. Extension of B1 stage 2 with per-target capture-blocks; includes fuzz oracle coverage.
- **Decision (2026-05-13):** **Bundle into the C5 PR alongside A2.** Keeps the catch-handler-resume work coherent in one PR — A2 (multi-target `*_ref`), A3 (multi-target plain catch), and the modern wasm-EH SDK flip land together. ~1–2 weeks added to C5 scope. Plain catches exist under both lowerings so A3 doesn't strictly depend on C5, but co-locating the work matches the review surface (catch-handler dispatch) and avoids two near-simultaneous PRs touching `instrument::plan_b1_scratch` and the 6d rewriter.

### A4. Plain-catch arms with ref-typed operands

- **Today:** Carved out at `instrument::plan_b1_scratch`. `docs/fork-instrumentation.md:737-742`. No shipping fork-path program forces it.
- **Why:** Spilling ref-typed catch operands to linear memory isn't legal (refs cannot be stored to linear memory). Would need a per-arm auxiliary *table* with index-based save/restore.
- **Impossible?** For funcref/externref: no, supportable with a dedicated aux table. For abstract GC refs: see A5.
- **Effort:** ~1 week for funcref/externref. Design + implementation + fuzz coverage.
- **Decision (2026-05-13):** **Bundle into the C5 PR. Scope clarified after A5 review: funcref / externref only.** Original decision was "all ref types including GC"; subsequent A5 review established that no current or near-term program (including the SpiderMonkey port, which uses linear-memory GC) exercises wasm-GC reference types in catch operands. GC refs remain under A5's accepted limit (the `classify_ref` panic persists for any GC ref position). C5 scope: modern wasm-EH SDK flip + libcxx rebuild + A2 (multi-target `*_ref`) + A3 (multi-target plain catch) + A4 funcref/externref catch operands. If a wasm-GC-using program later appears, A4's aux-table mechanism is the natural extension point.

### A5. Wasm-GC refs (`any` / `eq` / `struct` / `array` / `i31`, concrete GC types)

- **Today:** Rejected with a panic at `classify_ref`. `docs/fork-instrumentation.md:743-746`. Anticipated by a future SpiderMonkey port.
- **Why:** Wasm-GC's reference model has no in-tool way to enumerate live refs across a fork boundary. The GC heap is host-managed; the instrument tool sees only the module bytes.
- **Impossible?** Today, effectively yes — without host-managed GC root pinning. The instrument tool alone cannot save/restore GC heap state.
- **Effort:** Multi-week + cross-cutting: a host-side GC root table API exposed to the kernel, plus coordination with whatever runtime hosts GC (SpiderMonkey, V8 GC, etc.). Likely deferred until a real GC-using program is in scope.
- **Decision (2026-05-13):** **Accept as known limit.** Clarification during review: SpiderMonkey is a pre-wasm-GC engine — its JS heap lives in linear memory (`JSValue` is a tagged i64 SpiderMonkey allocates/traces/frees itself), so wasm-GC reference types are not exercised by the SpiderMonkey port either. The wasm-GC proposal is reserved for new languages targeting wasm with native GC (Java/Kotlin/Dart to wasm), none of which are on any roadmap. The `classify_ref` panic stays — it's a fail-fast for an unimplemented feature, not a silent miscompilation. Revisit only if a real wasm-GC-using program is in scope. Document this in `docs/fork-instrumentation.md` as the rationale for the panic (currently the doc only says "Add classes... when a real program needs them").

---

## Category B — Side effects not gated during guard-dispatch REWIND

Guard-dispatch re-executes the body top-to-bottom on REWIND to reach the matching `kernel_fork` call. Phase 4g gates the common side-effect instructions (`local.set`, `local.tee`, `global.set`, `store`, `memory.{grow,fill,copy,init}`, `data.drop`, `elem.drop`, `table.set`). The instructions below are *not* gated; a fork-path program that hits them between the fork call and the unwind boundary may misbehave during REWIND. Switch-dispatch (when applicable) sidesteps all of these by skipping the prefix body entirely.

### B1. Atomic RMW and `atomic.notify`

- **Today:** Not gated. `docs/fork-instrumentation.md:777`.
- **Why:** Atomic ops have cross-process observability — a no-op REWIND replay would still hit the shared address but with stale reads. The "frame-save the result, conditional `state==NORMAL`" pattern doesn't preserve cross-process ordering.
- **Impossible?** Hard. Atomics have observable side effects beyond the calling process; correct gating requires recording the atomic value on NORMAL and replaying it on REWIND, plus careful ordering.
- **Effort:** ~1–2 weeks. Per-op design with cross-process semantics.
- **Decision (2026-05-13, revised):** **Subsumed by the "eliminate guard-dispatch" architectural pivot — see B2, B3, B4.** B1 disappears as an instance once guard-dispatch is removed, because REWIND no longer re-executes the body.

### B2. `throw` / `throw_ref` outside instrumented regions

- **Today:** Not gated. `docs/fork-instrumentation.md:777`.
- **Why:** A throw from a non-fork-path function inside a fork-path try region is a control-flow side effect. The current gating reach is the fork-path call graph; throws from outside that reach aren't gated.
- **Impossible?** No — extend instrumentation reach. Indirect throws from uninstrumented libraries are harder.
- **Effort:** Medium. Depends on how much of the call graph we expand.
- **Decision (2026-05-13):** **Subsumed by the "eliminate guard-dispatch" architectural pivot.** See *Architectural pivot* below. B2 disappears as an instance once guard-dispatch is removed.

### B3. `table.grow`, `table.fill`, `table.init`, `table.copy`

- **Today:** Not gated. `docs/fork-instrumentation.md:778`.
- **Why:** Tables don't have a single scalar slot to round-trip a result through; the standard gating shape doesn't directly apply.
- **Impossible?** No.
- **Effort:** ~3–5 days. Design + per-op gating scheme, similar in spirit to memory-op gating.
- **Decision (2026-05-13):** **Subsumed by the "eliminate guard-dispatch" architectural pivot.** See *Architectural pivot* below.

### B4. Direct `Call` with non-nullable `Ref` return type

- **Today:** Not gated. `docs/fork-instrumentation.md:779-780`.
- **Why:** The frame-saved-result trick uses a scalar default (0); non-nullable refs have no zero value.
- **Impossible?** No, with caveats. Either skip-gate only when the result is consumed, or introduce a nullable mirror slot.
- **Effort:** ~1 week.
- **Decision (2026-05-13):** **Subsumed by the "eliminate guard-dispatch" architectural pivot.** See *Architectural pivot* below.

---

## Architectural pivot — Eliminate guard-dispatch

**Decided 2026-05-13.** B1–B4 are all instances of the same architectural hazard: guard-dispatch re-executes the body on REWIND, so every side-effect instruction class has to be gated individually. Eliminating guard-dispatch removes the class.

**Approach:**
- Extend switch-dispatch (already preferred; Path A landed in Phase 7) to cover every fork-path function. Today, the planner falls back to guard-dispatch when (a) fork-path calls live inside Loop/TryTable bodies with unsupported nesting, (b) the function has top-level stack carryovers (`*(sp + K) = call(...)`-style patterns LLVM emits routinely), or (c) fork-path calls are reached via `call_indirect`.
- Replace the (a)/(b)/(c) fallback with a **runtime-dispatcher trampoline**: post-call chunks are extracted into separate per-site functions registered in a per-function (or per-module) dispatch table. On REWIND, function entry sees `state == REWIND`, looks up the resume site ID from the save buffer, and `call_indirect`s into the matching post-call function.
- This eliminates the inline POST_K blocks for code-size, at the cost of a single `call_indirect` on the REWIND path (~5–20ns penalty per fork — well under noise floor for any realistic fork rate).

**Why now:**
- Phase 7 + Path A benchmark already shows switch-dispatch produces smaller, faster outputs than guard-dispatch (`fork_ms −9.8%`, `file_read_mbps +7.1%`). Extending the scheme across the residual fork-path functions amplifies the win.
- B1–B4 disappear as a class. Future side-effect instruction classes (proposals in flight: stack-switching, shared-everything-threads, GC) introduce new instruction shapes; under guard-dispatch each would need its own gating audit. Under switch-dispatch with trampoline they need no gating because the body doesn't re-execute.

**Cost / risk:**
- ~3–4 weeks focused implementation: extend `classify_nested_pattern` reach + add trampoline emission + delete guard-dispatch + re-run port validation across all shipping fork-using programs.
- Loss of graceful degradation: today, guard-dispatch is the safety net when switch-dispatch can't apply. After elimination, the trampoline IS the fallback for hard cases; if it has a bug there's no second-line defence. Mitigation: extensive fuzz coverage before deletion (the existing fork-instrument fuzz oracle is the right home).
- Re-validation of every shipping port (dash, bash, git, nginx, php-fpm, php, mariadb, vim, quickjs, cpython, redis, erlang, ruby) under the new scheme — none should regress per the small empirical evidence (Path A), but the full audit is required.

**Sequencing:**
- This becomes its own PR, **before** C5 (the modern wasm-EH SDK flip). Sequence:
  1. **PR-eliminate-guard-dispatch:** extend switch-dispatch + runtime trampoline + delete guard-dispatch. B1–B4 close as a class.
  2. **C5 PR:** modern wasm-EH SDK flip + libcxx rebuild + A2 + A3 + A4 (funcref/externref). Lands after eliminate-guard-dispatch so the new EH patterns can use the unified scheme without inheriting guard-dispatch hazards.

**Code-size reduction option added per user request:** the runtime-dispatcher trampoline is incorporated into the plan. It impacts NORMAL mode at near-zero cost (a single function-entry branch on state) and adds only a small REWIND-mode penalty (one `call_indirect`).

---

## Category C — Partial / known-broken / blocking flips

### C1. B1 plain-catch fork — first real-world validation

- **Today:** B1 stages 1+2 shipped on this PR. No real-world C++ EH+fork program has exercised the machinery; cpp_throw_test only validates EH itself, not EH+fork.
- **Plan:** Stage 3 needs the SpiderMonkey port or a synthetic C++ EH+fork fixture under `host/test/cpp-throw-test.test.ts`. Deferred per `docs/plans/2026-04-28-fork-instrument-b1-fork-from-plain-catch.md`.
- **Decision (2026-05-13):** **Add a synthetic fixture in this PR.** Land `cpp_eh_fork_from_catch.cpp` (or similar) under `host/test/cpp-throw-test.test.ts` or `crates/fork-instrument/tests/` that exercises a C++ try/catch with `fork()` inside the catch handler body, verifying both parent and child paths. Small, fast, gives B1 machinery a regression test ahead of any larger consumer (SpiderMonkey). ~1–2 days.

### C2. Test (b) post-catch fork-hang root cause

- **Today:** Saved task #16 was "in_progress with workaround." Workaround (the partial revert of PR #434's worker-main.ts) was dropped during today's rebase. The architectural Path-A switch-dispatch fix that landed in Phase 7 may already cover it; needs a fresh repro to confirm.
- **Plan:** Re-run the SpiderMonkey spike's test (b) against post-rebase fierce-wire. If hang reproduces, investigate concretely. If not, mark resolved.
- **Decision (2026-05-13):** **Reproduce test (b) now in this PR.** 1–2 hour investigation: run the SpiderMonkey-spike test (b) on current fierce-wire (post-rebase, workaround dropped). If it still hangs, root-cause and either fix or document concretely; if it doesn't, mark closed by PR #423's incidental fix (proper dlopen / GOT handling). Either outcome informs the eliminate-guard-dispatch PR's port re-validation.

### C3. fork-from-signal-handler

- **Today:** No fixture, no handling. Saved task #17.
- **Plan:** Extend call-graph discovery into registered sigaction handlers; treat them as fork-path roots. Add a fixture under `crates/fork-instrument/tests/` and an integration test that forks from a SIGALRM handler.
- **Effort:** ~1 week.
- **Decision (2026-05-13):** **Add in this PR — conservative + fixture.** Extend `instrument::discover_fork_path` to treat every address-taken function as a fork-path root (the conservative rule). Add a SIGUSR1 fork fixture exercising both parent and child paths. ~1 week. Lands in fierce-wire / PR #307. **Future work flagged:** if the conservative rule causes objectionable binary-size growth, implement the precise version (parse `sigaction()` callers to identify actual signal handlers via inter-procedural analysis or a libc hook). Recorded in `docs/future-improvements.md` under "Fork-instrument precise signal-handler discovery".

### C4. fork-from-cancellation-cleanup

- **Today:** No fixture, no handling. Saved task #18.
- **Plan:** Identify `pthread_cleanup_push` registrants; treat as fork-path roots. Add a fixture + test.
- **Effort:** ~1 week.
- **Decision (2026-05-13):** **Covered by C3 + add fixture in this PR.** C4 is structurally identical to C3 from the instrumenter's perspective — cleanup handlers are address-taken functions reached via host-managed callback registration. C3's conservative rule (treat every address-taken function as a fork-path root) covers cleanup handlers incidentally. Add a `pthread_cleanup_push` + fork fixture as a regression test in the same C3 PR work to prove the coverage holds. ~1 day for the fixture. **Future work flagged:** the precise variant described under C3's future-improvement entry must also extend to `pthread_cleanup_push` registrants when implemented.

### C5. Modern wasm-EH SDK flip

- **Today:** `sdk/src/lib/flags.ts:11` sets `-mllvm -wasm-use-legacy-eh=true`. Same flag is hardcoded in 8 test/build scripts and 2 raw-clang build scripts (`examples/libs/libcxx/build-libcxx.sh:119`, `examples/libs/lsof/build-lsof.sh:54`). Saved task #14.
- **Why blocking:** Until flipped, items A2 + A4 are dormant — no shipping binary emits modern-EH patterns that would force them.
- **Plan:** Flip flag SDK-wide, rebuild libcxx with modern lowering, publish a new `binaries-abi-v*` archive, rebuild every C++ program that uses EH (cpp_throw_test, vim, mariadb, php, quickjs), audit fork-instrument behavior under modern-EH binaries.
- **Effort:** Multi-day. Likely its own PR rather than a Phase 7 cleanup item.
- **Decision (2026-05-13):** **Bundle into a single mega-PR with the architectural pivot.** Combined scope: eliminate-guard-dispatch + runtime-dispatcher trampoline + modern wasm-EH SDK flip + libcxx rebuild & republish + A2 + A3 + A4 (funcref/externref) + comprehensive instrumentation/rewind test program. **No supported case left out** — the test program must exercise every supported instrumentation pattern and rewind path. ~6–10 weeks. Drafted as `docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md`. Mega-PR is high-risk but coherent: every component touches the dispatch core or the EH path; staging them as separate PRs would mean repeated rebase pain.

---

## How to use this document

For each item, a decision falls into one of:

- **Now (this PR):** Add the work to fierce-wire / PR #307.
- **Next PR (named):** Open a follow-up PR / branch with a written plan doc and link from here.
- **Deferred (linked):** Add a one-line entry under `docs/future-improvements.md` and link from here.
- **Accept as known limit:** Document the constraint in `docs/fork-instrumentation.md` and `docs/posix-status.md`; close the question.

Update each item's **Decision:** block in this doc as we work through them. The doc is the source of truth for what was decided and why.
