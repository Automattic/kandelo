# Torque CC Backend — Handoff Notes

## Purpose

Bootstrap future sessions. Not a plan, not a design, but a bridge. Captures decisions made during the 2026-04-20 brainstorming session so later Phase plans can be written without re-deriving the reasoning.

**Read order:** this doc → `2026-04-20-torque-cc-backend-design.md` → relevant Phase plan.

## Decisions Locked In

| Decision | Choice | Reason |
|---|---|---|
| Translator target language | **C++** | V8's entire Torque backend is C++; any other target pays a massive bridge-wrapper tax on V8's `Handle<T>`/`Tagged<T>`/`Isolate*` API. LLVM wasm32 codegen quality is equivalent across C/C++/Rust. |
| Translator implementation approach | **Patch V8's in-tree torque compiler** | Reuses parser, type checker, CFG builder, declaration visitor — ~tens of thousands of lines of V8 code we'd otherwise reimplement. |
| Extension seam | **Extend `CCGenerator` (add 12 instructions) + add `OutputType::kCCBuiltins` pass** | `TorqueCodeGenerator` is a pure-virtual base designed exactly for this; `ImplementationVisitor` already runs multiple passes with different `output_type_` values. |
| GC/Handle discipline | **Option A: Conservative Stack Scanning** | Matches existing CCGenerator style; zero translator complexity. Fallback to Option B (Handle discipline) if Task 0.8 reveals CSS+jitless incompatibility. |
| Scope of replacement | **Replace Layer 2 entirely** — no coexistence | Future-friendly maintenance: each V8 bump is a re-run, not a re-port. |
| Hand-written CSA gap | **Accept it, hand-write as surfaced** | ~100–200 CSA builtins in `src/builtins/builtins-*.cc` not in Torque. Small per-builtin (20–100 lines). ~200h total; surface via Phase 5 runtime errors rather than upfront audit. |
| Worktree policy | **Branch `torque-cc-backend` off `main`, NOT off `nosy-saffron`** | `nosy-saffron` has unrelated WIP; clean PR boundary matters. |
| Node.js source location | **`examples/libs/nodejs/build/node/`** (gitignored) | Matches pattern of other ports (`examples/libs/erlang/build/`, `examples/libs/cpython/build/`). |
| One-plan-per-phase | **Yes** | Phase 3 has design risk that could cascade; writing Phase 4+ plans now wastes effort if Phase 3 reveals the approach is wrong. |

## Verified Facts (Against V8 13.6.233.17 in Node.js v24.x)

Already confirmed via `gh api` during the brainstorming session:

- `src/torque/cc-generator.h` — `class CCGenerator : public TorqueCodeGenerator`
- `src/torque/csa-generator.h` — `class CSAGenerator : public TorqueCodeGenerator`
- `src/torque/torque-code-generator.h` — pure virtual `EmitInstruction` for backend-dependent ops
- `src/torque/instructions.h` — `TORQUE_BACKEND_DEPENDENT_INSTRUCTION_LIST` has **22 entries**, `TORQUE_BACKEND_AGNOSTIC_INSTRUCTION_LIST` has **3**
- `src/torque/cc-generator.cc` — **10 real emissions, 12 `ReportError("Not supported in C++ output: ...")` stubs**
- `src/torque/implementation-visitor.cc:3540–3575` — existing three-pass structure (kCSA implicit default, kCC, kCCDebug) with `AllMacrosForCCOutput()` / `AllMacrosForCCDebugOutput()` drivers
- `src/torque/implementation-visitor.cc:3583–3586` — per-declarable filter via `callable->ShouldGenerateExternalCode(output_type_)` nulling the file stream

Phase 0 tasks re-verify these against the actual cloned source. If the version has advanced (13.7+, 14.x), re-verification is required before trusting the line numbers.

## Per-Phase Outlines

Coarser than Phase 0's plan. Enough to bootstrap a fresh Phase N plan-writing session.

### Phase 1 — Scaffolding (2–3 days)

**Output:** a V8 patch file that adds the `kCCBuiltins` pass. Produces stub output per builtin (just `ReportError` for all 12 ops). Confirms the pass machinery works end-to-end before filling in real emission.

**Key files to patch:**
- `deps/v8/src/torque/` — add `kCCBuiltins` to `OutputType` enum (find enum via Phase 0 grep result)
- `deps/v8/src/torque/implementation-visitor.cc` at ~line 3575 (after kCCDebug block) — add fourth pass iterating over all builtins under `output_type_ = OutputType::kCCBuiltins`
- `deps/v8/src/torque/declarable.{h,cc}` — override `ShouldGenerateExternalCode(OutputType)` on `Builtin` to return `true` for `kCCBuiltins`
- `deps/v8/src/torque/cc-generator.{h,cc}` — (no changes yet — 12 stubs stay in place)
- `deps/v8/src/torque/BUILD.gn` — add new output files to torque outputs list

**Patch packaging:**
- Patch file at `examples/libs/nodejs/patches/v8-torque-cc-builtins.patch`
- Build script applies with `git -C deps/v8 apply --3way ...` (so later V8 bumps get conflict markers, not silent breakage)

**Validation:** after patch applies + torque rebuilds, run torque on a stock `.tq` file (smoke test from Task 0.9). Expect new `-tq-ccbuiltins.cc` file containing stub output like:

```cpp
// AUTO-GENERATED — DO NOT EDIT
namespace v8::internal {
void Builtin_ArrayIsArray(Isolate* isolate, /* args */) {
  // ReportError: Not supported in C++ output: Return
}
}
```

This is garbage but proves the pass runs.

### Phase 2 — Trivial + Mechanical Instructions (1 week)

**Implement in this order (easiest → hardest):**

1. `ReturnInstruction` — one-liner
2. `PushUninitializedInstruction` — `Tagged<Object> tmp;`
3. `NamespaceConstantInstruction` — reference to generated constant
4. `PushBuiltinPointerInstruction` — `&Builtin_Foo`
5. `StoreReferenceInstruction` — `TaggedField<T>::store(obj, offset, value)`
6. `StoreBitFieldInstruction` — `obj.set_bitfield(T::encode(v) | ...)`
7. `CallRuntimeInstruction` — `Runtime::Call<Runtime::kFoo>(isolate, args...)`
8. `CallBuiltinInstruction` — direct call to translated C++ builtin
9. `CallBuiltinPointerInstruction` — indirect call

**Code snippets drafted during brainstorming (reference only; match actual CSAGenerator patterns during implementation):**

```cpp
// ReturnInstruction
void CCGenerator::EmitInstruction(const ReturnInstruction& instruction,
                                  Stack<std::string>* stack) {
  out() << "  return ";
  CCGenerator::EmitCCValue(stack->Pop(), *stack, out());
  out() << ";\n";
}

// CallRuntimeInstruction
void CCGenerator::EmitInstruction(const CallRuntimeInstruction& instruction,
                                  Stack<std::string>* stack) {
  // Mirror CSAGenerator::EmitInstruction(CallRuntime*) — swap
  // CodeAssembler::CallRuntime(...) for Runtime::Call<Runtime::kFoo>(isolate, ...)
}
```

**TDD approach:** each instruction gets a minimal `.tq` test fixture in `examples/libs/nodejs/test/` that exercises just that instruction. Run torque on the fixture; compare generated C++ against a golden file.

**End-to-end goal:** pick `Array.prototype.indexOf` (small, hits Return + CallRuntime + LoadReference + Branch + Goto). Translate it. Link into V8's builtin table. Call it from a host C++ unit test. Verify `[1,2,3].indexOf(2) === 1`.

### Phase 3 — Non-Trivial Instructions (1–2 weeks) — DESIGN RISK

**The three hard ops:**

1. `CallCsaMacroAndBranchInstruction` — Torque labels (callee returns via one of N paths with per-path out-values)
2. `MakeLazyNodeInstruction` — thunk over a TNode
3. `GotoExternalInstruction` — jumping to a caller's label

**Signature rewrite pattern for CallCsaMacroAndBranch:**

Callee (translated macro) gets:
- One additional out-param: `LabelBranch* out_branch` (enum of label names)
- One additional out-param per label value: `Tagged<T>* out_value_for_label_X`

Callee writes `*out_branch = kLabelThrow; *out_value = ...; return;`

Caller:
```cpp
LabelBranch branch;
Tagged<Object> out_val;
Macro_Foo(isolate, args..., &branch, &out_val);
switch (branch) {
  case kFall: accumulator = out_val; break;
  case kLabelThrow: goto label_throw;
}
```

**Spike strategy:** implement `CallCsaMacroAndBranch` FIRST on a single simple case. If the signature rewrite is pervasive and ugly beyond expectations, consider alternatives (C++ exceptions? `std::variant` return? separate thunk functions?) before pattern-expanding. **This is where the design could fail.** Catch it here, not Phase 5.

**Lazy node:**

```cpp
// MakeLazyNodeInstruction
auto thunk_N = [=](Isolate* isolate) -> Tagged<T> {
  return inner_expr;  // captures locals by value
};
```

**Goto external:** uses the out-branch mechanism from CallCsaMacroAndBranch. Deferred until (1) lands.

### Phase 4 — Dispatch Table + CSS Build (3–5 days)

**Emit `builtins-cc-table.inc`:** generated alongside the CC-builtins output. Maps `Builtin::kFoo` → `&Builtin_Foo` (C++ function pointer). Torque's implementation visitor already knows every builtin's name + signature → straightforward to emit.

**Patch `src/builtins/builtins.cc`'s `Builtins::code(Builtin)`:**
- In jitless mode: return a small dispatch wrapper that calls into the table
- Or replace the mechanism entirely with direct C++ pointer calls from the interpreter

Pick based on how `Builtins::code` is consumed by V8's interpreter (`src/interpreter/`).

**Build V8 for host first** (not wasm). Debug crashes on a native build before layering on wasm cross-compilation pain. Then cross-compile to wasm32 via our SDK.

**GN flags:**
```
v8_enable_torque_cc_builtins = true
v8_enable_conservative_stack_scanning = true
v8_jitless = true
v8_enable_turbofan = false
v8_enable_sparkplug = false
v8_enable_maglev = false
v8_enable_webassembly = false
v8_enable_i18n_support = false
```

### Phase 5 — d8 Smoke Tests (1–2 weeks)

**Incremental targets:**
1. `d8 -e "print(1 + 2)"` → `3`
2. Object/array literals
3. Simple method calls (`"foo".toUpperCase()`)
4. Closures and lexical scope
5. try/catch/throw

**Expected pattern of failures:**
- `%RuntimeFunction` inlines → map to `Runtime_Foo` C++
- Missing CSA-only builtin → hand-write in `examples/libs/nodejs/csa-builtins/builtins-<group>.cc`, register via `builtins-cc-table.inc` override
- Translator bug (emitted C++ doesn't compile / segfaults) → fix in CCGenerator
- Kernel/libc issue → fix in kernel or libc shim

Keep a running ledger at `examples/libs/nodejs/csa-builtins/README.md` tracking hand-written replacements.

### Phase 6 — Full mjsunit (3–5 weeks)

**Harness:**
```bash
scripts/run-v8-mjsunit.sh                # all tests
scripts/run-v8-mjsunit.sh array          # single dir
scripts/run-v8-mjsunit.sh --report       # summary
```

Based on the pattern of `scripts/run-libc-tests.sh` and `scripts/run-posix-tests.sh`.

**Categorization:**
- `test/mjsunit/mjsunit.status` — V8's existing status file (handles `v8_jitless=true` automatically)
- `mjsunit.status.wasm32posix` — our overlay for platform-specific failures

**Target:** 0 unexpected failures. Same discipline as libc-test and sortix.

### Phase 7+ — Node.js Integration

Hands off to `2026-04-15-nodejs-port-design.md` Milestones 2–5:
- libuv cross-compile
- Node.js binding layer (`src/` in Node.js tree)
- Core modules (fs, path, events, stream, buffer, util, os, timers)
- Networking (http, net, dns)
- npm + Express

## Open Questions / Things To Watch

- **Phase 3 spike outcome.** Is `CallCsaMacroAndBranch` sane in C++ or does it need a different approach? Gate the translator's completion on this.
- **CSS interaction with wasm32 stack scanning.** CSS was designed for native stacks. Wasm's linear memory layout and the SDK's shadow stack may interact oddly. If CSS on wasm32 misses pointers in shadow stack → silent heap corruption. Investigate in Phase 4.
- **mksnapshot on host with no native codegen.** The snapshot serializer normally includes pointers into native builtin code objects. With C builtins, those become function pointers. Does mksnapshot handle that correctly, or do we need to teach it a new pointer encoding? Investigate at Phase 4 boundary.
- **Number of hand-written CSA builtins.** Estimate is ~100–200. Could be much higher if Torque migration upstream has stalled. Surface via Phase 5; don't audit upfront.

## Invariants (Do Not Break)

- Branch `torque-cc-backend` off `main` only. Not off `nosy-saffron`, not off `feature/nodejs-port`.
- Never push directly to main (per project memory).
- Platform-level fixes only. No Torque-on-V8 hacks, no "disable this builtin to avoid the issue." The point is a real replacement.
- CCGenerator's existing output style is the template. Match its conventions in the 12 new emissions — future readers comparing CSA vs CC output need consistency.
- Every added instruction emission gets a TDD fixture. Design's Phase 2 calls for this explicitly.

## Files & Paths Committed During Brainstorming Session

- `docs/plans/2026-04-20-torque-cc-backend-design.md` — the design doc
- `docs/plans/2026-04-20-torque-cc-backend-phase0.md` — Phase 0 plan
- `docs/plans/2026-04-20-torque-cc-backend-handoff.md` — this file

## For the Session Resuming Here

1. Read this doc first (orients you).
2. Read the design doc (gives you the "why").
3. If Phase 0 already ran: read `examples/libs/nodejs/verification.md` and the Phase 0 summary table.
4. To write the next phase plan: use `superpowers:writing-plans` skill with the matching phase outline above as the starting point.
5. Check memory `MEMORY.md` for any updated entries on this initiative.
