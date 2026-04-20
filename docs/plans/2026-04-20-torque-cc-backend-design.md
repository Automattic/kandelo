# Torque → C++ Backend for V8 Builtins

## Goal

Build a future-friendly replacement for Layer 2 of the Node.js port (the ~2K lines of "Builtin Function Redirects" described in `docs/plans/2026-04-15-nodejs-port-design.md`). Instead of hand-writing C implementations of V8's ~1000+ builtins, translate V8's own Torque DSL sources to portable C++ that compiles to wasm32.

Success criteria:

- Each V8 bump is a re-run of the translator, not a re-write of Layer 2.
- Translated builtins compile to wasm32 via our existing `wasm32posix-c++` SDK.
- `d8 -e "print(1 + 2)"` works on Node.js 24's V8 (13.6.233.17) running in our kernel.

## Prior Art

V8 ships its own Torque compiler (`src/torque/`) with two backends:

- **CSAGenerator** — the default, emits CSA C++ that generates native machine code at V8 build time. Used for real builtins.
- **CCGenerator** — emits portable C++ for macros marked `@export`, so runtime C++ can call a subset of Torque helpers directly without going through CSA.

CCGenerator is the designed-in extension seam for what we want. It is not hypothetical — it is tested and used today. It just doesn't cover full builtins, only the `@export` subset.

## Key Finding

The Torque compiler partitions instructions into two lists in `src/torque/instructions.h`:

- `TORQUE_BACKEND_AGNOSTIC_INSTRUCTION_LIST` (3 ops, emitted in the base class)
- `TORQUE_BACKEND_DEPENDENT_INSTRUCTION_LIST` (22 ops, pure-virtual in `TorqueCodeGenerator`)

CCGenerator today implements 10 of the 22 for real. The other 12 are stubs:

```cpp
void CCGenerator::EmitInstruction(const CallRuntimeInstruction&, ...) {
  ReportError("Not supported in C++ output: CallRuntime");
}
```

The 12 unsupported ops are exactly the ones an `@export` helper wouldn't need but a full builtin would:
`CallBuiltinInstruction`, `CallBuiltinPointerInstruction`, `CallRuntimeInstruction`, `ReturnInstruction`, `StoreReferenceInstruction`, `StoreBitFieldInstruction`, `NamespaceConstantInstruction`, `PushUninitializedInstruction`, `PushBuiltinPointerInstruction`, `CallCsaMacroAndBranchInstruction`, `MakeLazyNodeInstruction`, `GotoExternalInstruction`.

**Our work is to fill in those 12 `ReportError` stubs.** Everything else — parser, type checker, CFG, declaration visitor, dispatch — we reuse untouched.

The backend selector is per-pass state on `ImplementationVisitor`. `implementation-visitor.cc:3540–3575` shows the existing three-pass structure (`kCSA`, `kCC`, `kCCDebug`); we add a fourth pass `kCCBuiltins`. Per-declarable filtering uses `Callable::ShouldGenerateExternalCode(OutputType)`, which we override to return true for all builtins under the new pass.

## Design

### Placement

Patches to V8's in-tree torque compiler, not a standalone tool:

```
deps/v8/src/torque/
  torque-code-generator.h           unchanged
  csa-generator.{h,cc}              unchanged
  cc-generator.{h,cc}               EXTENDED: 12 new EmitInstruction impls
  implementation-visitor.{h,cc}     PATCHED: kCCBuiltins pass
  declarable.{h,cc}                 PATCHED: ShouldGenerateExternalCode
                                             returns true for builtins under
                                             kCCBuiltins
```

The CSA pass is still run — V8's snapshot serialization, class definitions, instance type tables, body descriptors, and root-visitor tables are emitted during the CSA pass even when CSA code itself is dead. We want that metadata. We just want pass 4's output to be what the dispatch table calls at runtime.

Output layout per torque run:

| Pass | Output files | Purpose |
|---|---|---|
| kCSA | `torque-generated/*-tq-csa.{cc,h}` | Metadata (snapshot, classes, types); CSA code dead in jitless |
| kCC | `torque-generated/*-tq.{cc,inc}` | Existing `@export` path |
| kCCDebug | `torque-generated/*-tq-debug.{cc,inc}` | Existing debug path |
| **kCCBuiltins (new)** | `torque-generated/cc-builtins/*-tq-ccbuiltins.cc` | Translated builtins |

### Extending CCGenerator

Breakdown of the 12 missing instructions by difficulty:

**Trivial (4):**

- `ReturnInstruction` → `return <stack.top()>;`
- `PushUninitializedInstruction` → `Tagged<Object> tmp;`
- `PushBuiltinPointerInstruction` → emit address of generated C++ builtin function
- `NamespaceConstantInstruction` → emit reference to generated C++ constant

**Mechanical (5):**

- `CallBuiltinInstruction` → direct call to the translated C++ builtin, threading `Isolate*` and `Context` as implicit params
- `CallBuiltinPointerInstruction` → indirect call via function pointer
- `CallRuntimeInstruction` → `Runtime::Call<Runtime::kFoo>(isolate, args...)` (already C++-callable)
- `StoreReferenceInstruction` → `TaggedField<T>::store(obj, offset, value)` (existing portable accessor)
- `StoreBitFieldInstruction` → `obj.set_bitfield(T::encode(v) | ...)`

**Non-trivial (3):**

- `CallCsaMacroAndBranchInstruction` — Torque labels let a callee return via one of N paths with per-path out-values. In CSA this is a jump-table. In C++ we emit out-param-based branching: callee writes `*out_branch = kLabelThrow; *out_val = ...; return;`, caller switches on branch and gotos the matching label. Mechanical but requires signature rewriting — translated macros have different C++ signatures than their CSA counterparts.
- `MakeLazyNodeInstruction` — thunk over a TNode value. Emit as a small captured lambda bound to current locals.
- `GotoExternalInstruction` — jumping to a caller's label. Uses the same out-branch mechanism.

Estimated delta: ~800–1200 lines added to `cc-generator.cc`, mirroring `csa-generator.cc` but dropping CSA abstractions.

### GC via Conservative Stack Scanning

Native CSA handles GC via stackmap metadata. Portable C++ can't — Tagged values sitting in stack locals across GC-triggering calls would be invalidated when objects move.

**Solution: conservative stack scanning (CSS).** V8 13.x supports `v8_enable_conservative_stack_scanning=true`. The GC treats the native C stack as a conservative root set — any word that looks like a heap pointer is treated as live. Translated builtins use raw `Tagged<T>` locals freely; no `Handle` or `HandleScope` discipline needed.

This matches how the existing CCGenerator emits code today. It adds zero translator complexity. It is the path V8 ships on production hosts.

**Verification gate (Phase 0):** confirm `v8_enable_conservative_stack_scanning` is functional with `v8_jitless=true` before we commit to it. If CSS turns out unworkable, fall back to explicit `Handle<T>` wrapping everywhere Tagged values cross GC-safepoints (~30–50% more translator LOC, full `HandleScope` emission).

### Non-Torque Builtins

Not every V8 builtin is in Torque. Three sources exist:

| Source | Count | Status |
|---|---|---|
| Torque `.tq` files | ~500–700 | Translator handles end-to-end |
| Hand-written CSA (`TF_BUILTIN` in `src/builtins/builtins-*.cc`) | ~100–200 | Hand-write portable C++ replacements |
| Runtime C++ (`BUILTIN(...)` in `src/builtins/builtins-*.cc`) | varies | Work as-is, zero effort |

The CSA ones are the leftover Layer 2 work. Most are 20–100 lines each; estimate ~200 hours total to hand-write replacements. Ongoing cost per V8 bump: re-port any that changed — expected to be small (~few days).

Side effort: contribute CSA→Torque migrations upstream. The V8 team is slowly doing this anyway; each migration shrinks our hand-written surface.

### Build Integration

V8's build is GN + ninja, wrapped by Node.js's `configure` / `make`. Host-side torque binary unchanged in shape; the patches modify what it emits.

New GN args:

```
v8_enable_torque_cc_builtins = true
v8_enable_conservative_stack_scanning = true
v8_jitless = true
v8_enable_turbofan = false
```

Build rule delta in `src/torque/BUILD.gn`: add the new output file set alongside the existing `-tq-csa.cc`, `-tq.cc`, `-tq-debug.cc` outputs.

Linking: new `.cc` files join `v8_base_without_compiler`. They see `Isolate`, `Factory`, `Runtime`, everything. Compilation goes through `wasm32posix-c++`.

**Builtin dispatch reroute.** `Builtins::code(Builtin)` today returns a `Tagged<Code>` pointing at native machine code. In jitless + C-builtins mode, replace the dispatch table with an array of C++ function pointers indexed by `Builtin`. The table is generated at V8 build time: the torque compiler knows every builtin's name and signature, so emit `builtins-cc-table.inc` populating the array. Hand-written replacements from the CSA set register into the same table.

mksnapshot stays as-is — generates heap snapshot metadata, no machine code in jitless mode.

## Phasing

**Phase 0: Verify in-tree (½ day).** Clone `nodejs/node` v24.x. Build stock torque binary on host. Confirm `v8_enable_conservative_stack_scanning` exists and compiles with `v8_jitless=true`.

**Phase 1: Scaffolding (2–3 days).** Add `OutputType::kCCBuiltins`. Add fourth pass in `GenerateImplementation`. Add `ShouldGenerateExternalCode` override. Output still `ReportError` stubs; confirm no regression in existing passes.

**Phase 2: Trivial + mechanical instructions (1 week).** Implement 4 trivial + 5 mechanical ops. Pick a small Torque builtin (e.g., `Array.prototype.indexOf`) and translate it end-to-end. Verify by calling from V8's C++ and checking the result.

**Phase 3: Non-trivial instructions (1–2 weeks).** `CallCsaMacroAndBranchInstruction`, `MakeLazyNodeInstruction`, `GotoExternalInstruction`. Design-risk phase — if the approach is wrong, surface it here.

**Phase 4: Dispatch table + CSS build (3–5 days).** Emit `builtins-cc-table.inc`. Reroute `Builtins::code`. Build V8 with CSS + the new pass. `d8.wasm` boots.

**Phase 5: d8 smoke tests (1–2 weeks).** `d8 -e "print(1 + 2)"` → `3`. Then object literals, arrays, closures, try/catch. Missing CSA-only builtins surface as runtime errors; hand-write replacements as they surface.

**Phase 6: Full mjsunit (3–5 weeks).** Run the full `test/mjsunit/` suite against `d8.wasm`. V8's existing `mjsunit.status` already categorizes JIT-dependent tests as SKIP/FAIL_OK when `v8_jitless=true`. Add a `mjsunit.status.wasm32posix` overlay for additional expected failures (missing CSA builtins, memory-layout-specific tests, kernel/ABI differences). Target: 0 unexpected failures, same pattern as libc-test and sortix.

**Phase 7+: Node.js integration.** Picks up from Milestone 2+ in `2026-04-15-nodejs-port-design.md` (libuv cross-compile, Node.js binding layer, core modules, networking, npm).

**Estimate to working d8 (end of Phase 6): 6–10 weeks.** Assumes no architectural surprises in Phase 3.

## Risks

- **Phase 3 semantics.** `CallCsaMacroAndBranchInstruction` rewriting might be uglier or more pervasive than expected. Mitigation: spike the signature-rewrite in Phase 2 before committing the whole translator to it.
- **CSS unavailability.** If conservative stack scanning doesn't work with jitless + our wasm32 toolchain, we fall to explicit Handle discipline. Translator gets ~40% larger; phasing extends by ~2 weeks.
- **CSA builtin count.** If the hand-written CSA set turns out to be >200 builtins and heavy, Phase 5/6 stretches. Mitigation: triage by frequency — fix the ones mjsunit hits first.
- **V8 upstream drift.** Each V8 bump may introduce new Torque constructs (e.g., a 23rd backend-dependent instruction). We track V8's `src/torque/instructions.h` diffs per bump.

## Out of Scope

- Full Node.js boot — covered by `2026-04-15-nodejs-port-design.md`, Milestones 2+.
- CSA→Torque migrations upstream — ongoing side effort, not a blocker.
- Intl, inspector, crypto native bindings, WASI support — inherited exclusions from the parent plan.
