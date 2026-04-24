# Phase 0 Verification

## Phase 0 Summary

| Item | Result |
|---|---|
| Node.js v24.x cloned (HEAD `9fe7634c`) | ✅ |
| V8 version matches design (13.6.233.17) | ✅ |
| Torque binary builds on host | ✅ |
| CCGenerator shape matches design (CCGenerator + CSAGenerator extend TorqueCodeGenerator) | ✅ |
| 22 backend-dependent + 3 agnostic instructions confirmed | ✅ |
| 12 stub instructions confirmed (exact set matches design) | ✅ |
| Fourth-pass seam confirmed (OutputType enum, pass driver, per-declarable filter) | ✅ |
| CSS + jitless compatible (full `v8_snapshot` build, 2541/2541 steps, 0 errors) | ✅ |
| Torque round-trips stock .tq files on host | ✅ |

**Decision: proceed to Phase 1 on Option A (Conservative Stack Scanning).**
No design pivot required.


Verified against Node.js v24.x (V8 13.6.233.17) cloned at
`examples/libs/nodejs/build/node/`.

Node.js HEAD: `9fe7634c` (v24.x branch, 2026-04-20 clone).
V8 version string from `deps/v8/include/v8-version.h`: **13.6.233.17** — matches design.

## V8 source shape (Task 0.5)

- `deps/v8/src/torque/cc-generator.h:14` — `class CCGenerator : public TorqueCodeGenerator {` ✅
- `deps/v8/src/torque/csa-generator.h:14` — `class CSAGenerator : public TorqueCodeGenerator {` ✅
- `deps/v8/src/torque/instructions.h:27` — `TORQUE_BACKEND_AGNOSTIC_INSTRUCTION_LIST` defined
- `deps/v8/src/torque/instructions.h:33` — `TORQUE_BACKEND_DEPENDENT_INSTRUCTION_LIST` defined

### Instruction list counts

- Backend-agnostic: **3** (`PeekInstruction`, `PokeInstruction`, `DeleteRangeInstruction`) — matches design
- Backend-dependent: **22** — matches design

Full backend-dependent list (in declaration order, `instructions.h:33–55`):
`PushUninitializedInstruction`, `PushBuiltinPointerInstruction`,
`LoadReferenceInstruction`, `StoreReferenceInstruction`,
`LoadBitFieldInstruction`, `StoreBitFieldInstruction`,
`CallCsaMacroInstruction`, `CallIntrinsicInstruction`,
`NamespaceConstantInstruction`, `CallCsaMacroAndBranchInstruction`,
`CallBuiltinInstruction`, `CallRuntimeInstruction`,
`CallBuiltinPointerInstruction`, `BranchInstruction`,
`ConstexprBranchInstruction`, `GotoInstruction`, `GotoExternalInstruction`,
`MakeLazyNodeInstruction`, `ReturnInstruction`, `PrintErrorInstruction`,
`AbortInstruction`, `UnsafeCastInstruction`.

## CCGenerator stubs vs real emissions (Task 0.6)

`cc-generator.cc` contains an `EmitInstruction` override for all 22
backend-dependent instructions. Of those:

**12 stubs** (emit `ReportError("Not supported in C++ output: …")`):
| Line | Instruction |
|------|-------------|
| 87   | `PushUninitializedInstruction` |
| 93   | `PushBuiltinPointerInstruction` |
| 99   | `NamespaceConstantInstruction` |
| 260  | `CallCsaMacroAndBranchInstruction` |
| 265  | `MakeLazyNodeInstruction` |
| 270  | `CallBuiltinInstruction` |
| 276  | `CallBuiltinPointerInstruction` |
| 281  | `CallRuntimeInstruction` |
| 323  | `GotoExternalInstruction` |
| 328  | `ReturnInstruction` |
| 443  | `StoreReferenceInstruction` |
| 490  | `StoreBitFieldInstruction` |

**10 real emissions:**
| Line | Instruction |
|------|-------------|
| 124  | `CallIntrinsicInstruction` |
| 207  | `CallCsaMacroInstruction` |
| 284  | `BranchInstruction` |
| 293  | `ConstexprBranchInstruction` |
| 316  | `GotoInstruction` |
| 331  | `PrintErrorInstruction` |
| 337  | `AbortInstruction` |
| 362  | `UnsafeCastInstruction` |
| 371  | `LoadReferenceInstruction` |
| 458  | `LoadBitFieldInstruction` |

Exactly matches the design's "10 real + 12 stubs" claim. ✅

## Fourth-pass extension seam (Task 0.7)

Design specifies: add `OutputType::kCCBuiltins` and a fourth pass in
`GenerateImplementation`; override per-declarable filter on `Builtin`.
All three seams exist and are close to the line numbers the design cites.

| Seam | File | Line | Notes |
|------|------|------|-------|
| OutputType enum | `deps/v8/src/torque/declarable.h` | **295** | Three values: `kCSA`, `kCC`, `kCCDebug`. Phase 1 adds `kCCBuiltins`. |
| Pass driver (`kCC`) | `deps/v8/src/torque/implementation-visitor.cc` | **3549** | Iterates `GlobalContext::AllMacrosForCCOutput()`. |
| Pass driver (`kCCDebug`) | `deps/v8/src/torque/implementation-visitor.cc` | **3562** | Iterates `GlobalContext::AllMacrosForCCDebugOutput()`. |
| Pass reset (`kCSA`) | `deps/v8/src/torque/implementation-visitor.cc` | **3574** | Reverts `output_type_` after the two C++ passes. |
| Per-declarable filter | `deps/v8/src/torque/implementation-visitor.cc` | **3585** | `if (!callable->ShouldGenerateExternalCode(output_type_)) CurrentFileStreams::Get() = nullptr;` |
| `ShouldGenerateExternalCode` | `deps/v8/src/torque/declarable.h` | **323** | **Non-virtual**; delegates to `ShouldBeInlined(output_type)` at line 318 which IS virtual. |

Design line ranges (3540–3575 for passes, 3583–3586 for filter) match
current V8 13.6.233.17 to within 2 lines.

**Phase 1 note:** the design says "override `ShouldGenerateExternalCode`
on `Builtin`." Because the non-virtual wrapper calls `virtual
ShouldBeInlined`, the actual Phase 1 override target is `ShouldBeInlined`
on `Builtin`, or we convert the wrapper to virtual. Both are mechanical.

## CSS + jitless compatibility (Task 0.8) — **GATE PASSED**

**Decision:** Option A (Conservative Stack Scanning) is viable.
No pivot to Option B (Handle discipline) required.

### Configuration

- GN flag `v8_enable_conservative_stack_scanning` declared at
  `deps/v8/gni/v8.gni:127` (default `false`).
- Gyp plumbing already exists:
  `common.gypi:81`, `tools/v8_gypfiles/features.gypi:216/479` —
  `v8_enable_conservative_stack_scanning=1` emits
  `-DV8_ENABLE_CONSERVATIVE_STACK_SCANNING`.
- Node.js configure has no direct flag for it, but `GYP_DEFINES` from
  the environment propagates through gyp into CXXFLAGS.
- `--v8-lite-mode` sets `v8_enable_lite_mode=1`, defining `V8_LITE_MODE`
  (the "jitless" umbrella; see `gni/v8.gni:442–446`).

### Static analysis

- No incompatibility guards between CSS and jitless/LITE_MODE anywhere
  in `deps/v8/` (searched `jitless.*conservative_stack` and
  `CONSERVATIVE_STACK_SCANNING.*LITE_MODE` — no matches).
- `deps/v8/BUILD.gn:639` asserts jitless excludes Sparkplug/Maglev/
  Turbofan/Wasm, but not CSS.
- `deps/v8/src/handles/handles.h:397`:
  `static_assert(V8_ENABLE_CONSERVATIVE_STACK_SCANNING_BOOL);` under
  `#ifdef V8_ENABLE_DIRECT_HANDLE`. CSS + direct-handles is the
  intended production pairing.
- CSS gates live code in
  `src/heap/heap.cc:131`, `src/heap/heap.cc:4867`,
  `src/common/ptr-compr-inl.h:227`,
  `src/runtime/runtime-strings.cc:390`,
  `src/handles/handles.h`, and
  `src/flags/flag-definitions.h:463–473` (read-only flag with
  implications `scavenger_conservative_object_pinning` and
  negated `compact_with_stack`).

### Build proof

Ran a full V8 snapshot build with both flags on:

```bash
mv out/Release out/Release.baseline
GYP_DEFINES="v8_enable_conservative_stack_scanning=1" \
  ./configure --ninja --v8-lite-mode
ninja -C out/Release v8_snapshot
```

Result: **2541/2541 steps, exit 0**, no warnings or errors in
2013 lines of build log. Artifacts produced:
- `out/Release/libv8_snapshot.a` (2.5 MB)
- `out/Release/mksnapshot` (linked successfully)

The CXXFLAGS for `v8_base_without_compiler` contained both defines:
```
-DV8_ENABLE_CONSERVATIVE_STACK_SCANNING ... -DV8_LITE_MODE
```

This compiled cleanly across every `torque-generated/*-tq.o` target,
`heap.o`, `handles.o`, runtime-strings.o, and the full mksnapshot
executable. Phase 1 may proceed on Option A.

## Torque smoke test on stock .tq files (Task 0.9)

Invoked the host torque binary on the full set of 245 stock `.tq` files
(main `torque_files` list from `deps/v8/BUILD.gn:1914` + conditional
`v8_enable_webassembly` + `v8_enable_i18n_support` blocks, deduplicated).

```bash
/tmp/torque-baseline -o /tmp/torque-out -v8-root deps/v8 <245 .tq files>
```

Exit: **0**. No errors, no lint warnings.

**Gotcha:** torque's `ReplaceFileContentsIfDifferent` does **not** create
parent directories — missing dirs cause silent write failures. We
pre-created the target dirs with `mkdir -p` derived from the `.tq` file
paths. V8's `tools/run.py` wrapper script handles this in-tree, which is
why the stock build doesn't hit it.

**Output layout** (1245 files total):

- Per-source: `/<dir>/<name>-tq-csa.cc`, `-tq-csa.h`, `-tq.cc`, `-tq.inc`,
  `-tq-inl.inc` — 5 files per `.tq` input. (`-tq.cc` is the existing
  kCC-pass output; empty for files with no `@export` macros.)
- Shared: `factory.cc`, `exported-macros-assembler.cc`, `debug-macros.cc`,
  `class-verifiers.cc`, `class-debug-readers.cc`, `enum-verifiers.cc`,
  `objects-printer.cc`, `bit-fields.h`, `builtin-definitions.h`,
  `csa-types.h`, `class-forward-declarations.h`, `factory.inc`,
  `instance-types.h`, `interface-descriptors.inc`,
  `objects-body-descriptors-inl.inc`, `visitor-lists.h`.

**Sample CSA output** (`src/builtins/array-isarray-tq-csa.cc`):

```cpp
TF_BUILTIN(ArrayIsArray, CodeStubAssembler) {
  compiler::CodeAssemblerState* state_ = state();
  compiler::CodeAssembler ca_(state());
  TNode<NativeContext> parameter0 =
      UncheckedParameter<NativeContext>(Descriptor::kContext);
  ...
  tmp6 = TORQUE_CAST(CodeStubAssembler(state_).CallRuntime(
      Runtime::kArrayIsArray, parameter0, parameter1));
  CodeStubAssembler(state_).Return(tmp6);
```

This is what the Torque CC backend will replace: `TNode<>` becomes
`Tagged<>`, `CodeStubAssembler::CallRuntime` becomes
`Runtime::Call<Runtime::kArrayIsArray>(isolate, ...)`, `ca_.Goto/Bind`
become structured C++ control flow.

**Torque CLI reference for later phases:**

| Flag | Meaning |
|------|---------|
| `-o <dir>` | Output directory (parent dirs must exist) |
| `-v8-root <dir>` | Prefix stripped from input paths (e.g., `deps/v8`) |
| `-strip-v8-root` | Strip v8-root from generated paths |
| `-annotate-ir` | Dump intermediate representation |
| `-m32` | Force 32-bit output (incompatible with pointer compression) |

No `-h` / `--help` — torque aborts on unknown args.

## Torque host build (Tasks 0.2–0.4)

- Node.js uses gyp+ninja (not `make torque` as the skeleton assumed).
- Correct invocation: `ninja -C out/Release torque` after `./configure --ninja`.
- Resulting binary: `examples/libs/nodejs/build/node/out/Release/torque`
  (Mach-O 64-bit arm64 on host macOS).
- `torque --help` does not exist — torque aborts on any unknown arg. The
  build script now just verifies the binary is executable.

## Phase 1 Summary

| Item | Result |
|---|---|
| `OutputType::kCCBuiltins` enum entry added | ✅ |
| `PerFileStreams.cc_builtins_{header,cc}file` streams added | ✅ |
| `csa_ccfile()` / `csa_headerfile()` route kCCBuiltins | ✅ |
| Third `output_type_` switch in `implementation-visitor.cc:~2945` handles kCCBuiltins | ✅ |
| `Builtin::ShouldBeInlined` returns false for kCCBuiltins; `Callable` base returns true | ✅ |
| Fourth pass in `VisitAllDeclarables` iterates and filters to `Declarable::kBuiltin` only | ✅ |
| `Visit(Builtin*)` emits Phase-1 stub under kCCBuiltins (early-return, no assembler) | ✅ |
| `-tq-ccbuiltins.cc` file written per source (banner always present) | ✅ |
| `BUILD.gn` `run_torque` outputs list includes new file | ✅ |
| No regression in kCSA / kCC / kCCDebug output (Task 1.10 diff empty; checksum preserved) | ✅ |
| Patch exports cleanly, re-applies on fresh clone | ✅ |
| `build-nodejs.sh` applies `patches/*.patch` with marker-based idempotency | ✅ |

**Phase 1 commit chain on the Node.js clone** (10 commits, base `9fe7634c` → tip `2440f125`):
1. `torque: add OutputType::kCCBuiltins (Phase 1 scaffolding)`
2. `torque: add cc_builtins file streams to PerFileStreams`
3. `torque: route kCCBuiltins output to cc_builtins streams`
4. `torque: Builtin::ShouldBeInlined returns false for kCCBuiltins`
5. `torque: route kCCBuiltins through extern-macro constexpr call path`
6. `torque: add kCCBuiltins fourth pass in VisitAllDeclarables`
7. `torque: Visit(Builtin*) emits Phase 1 stub under kCCBuiltins`
8. `torque: filter fourth pass to Builtin declarables only`
9. `torque: write -tq-ccbuiltins.cc per source file`
10. `v8 build: declare -tq-ccbuiltins.cc in run_torque outputs`

Exported as a single patch at `examples/libs/nodejs/patches/v8-torque-cc-builtins.patch` (13,420 bytes).

**Regression evidence.** Patched-torque run over the full 245-file stock fileset produces 1490 files: 1245 baseline (byte-identical to Phase 0 snapshot; `shasum a5195c0258fd9af9415e9d41f0c2e38237989c1b`) plus 245 new `-tq-ccbuiltins.cc` files. `diff -r --exclude='*-tq-ccbuiltins.cc'` between baseline and post-patch trees is empty.

**Sample output** (`src/builtins/array-isarray-tq-ccbuiltins.cc`, 15 lines):

```cpp
// Copyright 2024 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

// AUTO-GENERATED by torque CC-Builtins backend (Phase 1 scaffolding).
// Source: src/builtins/array-isarray.tq
// DO NOT EDIT.

namespace v8::internal {

// Builtin: ArrayIsArray
// (Phase 1 stub — body intentionally empty)
// void Builtin_ArrayIsArray(Isolate* isolate /* + args */);

}  // namespace v8::internal
```

A pure-definition `.tq` with no builtins (e.g. `src/objects/js-objects.tq`) still gets the banner + empty namespace — BUILD.gn lists the output per `.tq` input unconditionally.

### Plan deviations surfaced during implementation (documented for future phases)

- **`all_declarables` iteration is NOT safe under `kCCBuiltins` without a kind filter.** The Phase 1 plan originally assumed non-Callable `Visit(Declarable*)` arms early-return; in reality, `NamespaceConstant`/`TorqueMacro`/`Method` drive codegen machinery that crashes (SIGSEGV) or emits stray output when re-entered under a non-`kCSA` output type. Fixed by adding `if (all_declarables[i]->kind() != Declarable::kBuiltin) continue;` at the top of the fourth-pass loop body — matches the pattern of the kCC/kCCDebug passes iterating curated lists.
- **Third `output_type_` switch at `implementation-visitor.cc:~2945`** (extern-macro constexpr call emission) was not in the plan's list but triggers a `-Wswitch` warning without a case. Added a `kCCBuiltins` arm that mirrors `kCC`'s `CCName()` call — forward-compatible for Phase 2's real builtin-body emission.
- **Single-file torque smoke test is unworkable.** Phase 0 Task 0.9's documented single-file invocation (`torque deps/v8/src/builtins/array-isarray.tq`) was never actually executed — single-file runs abort on unresolved types like `Context`. All Phase 1 torque invocations used the full 245-file stock fileset with pre-created output subdirectories. File list: `/tmp/phase1-tq-files.txt`.
- **`out/Release/` vs `out/Release.baseline/`.** Phase 0 Task 0.8's CSS+jitless gate reconfigured `out/Release/` to lite-mode, which drops `V8_ENABLE_WEBASSEMBLY`; the preserved `out/Release.baseline/` is the stock-configured build and is what Phase 1 used for all rebuilds and smoke tests.

### Phase 1 follow-ups for later phases (not blockers)

- **gyp integration for new outputs.** Node.js's build uses gyp, not GN. `tools/v8_gypfiles/v8.gyp` derives per-torque-file outputs programmatically (`torque_outputs_csa_cc`, `torque_outputs_csa_h`, etc.) rather than reading them from BUILD.gn. **Phase 4 (dispatch table + CSS build) must add `torque_outputs_ccbuiltins_cc`** before `-tq-ccbuiltins.cc` files are compiled into the V8 library. The Phase 1 BUILD.gn edit keeps upstream-V8 consistency but does not affect Node.js's gyp-driven V8 link.
- **`build-nodejs.sh` torque-build step is idempotent against existing binary.** The `[ ! -f "out/Release/torque" ]` guard means the script skips the rebuild even when patches have just been applied. Phase 1 does not enforce this because `out/Release/` is stale lite-mode anyway; a later phase should rebuild after patch-apply unconditionally (or track patch SHAs against binary SHA).

**Next:** Phase 2. Write `docs/plans/2026-04-20-torque-cc-backend-phase2.md` covering the 4 trivial + 5 mechanical instructions per the handoff doc's Phase 2 outline. Start with `ReturnInstruction`.

## Phase 2 Summary

| Item | Result |
|---|---|
| `--cc-builtins-whitelist=<csv>` CLI flag added (both `--` and `-` forms, whitespace-trimmed) | ✅ |
| `Visit(Builtin*)` under kCCBuiltins: whitelist-gated real emission, JS-linkage deferred, Phase-1 stub fallthrough | ✅ |
| `ReturnInstruction` emission | ✅ |
| `PushUninitializedInstruction` emission (unwraps `TopType` to source type) | ✅ |
| `NamespaceConstantInstruction` emission | ✅ |
| `PushBuiltinPointerInstruction` emission (placeholder via `Smi::FromInt(Builtin::k…)`) | ✅ |
| `StoreReferenceInstruction` emission | ✅ |
| `StoreBitFieldInstruction` emission (reuses existing `GetBitFieldSpecialization` helper) | ✅ |
| `CallRuntimeInstruction` emission (catch-block deferred to Phase 3) | ✅ |
| `CallBuiltinInstruction` emission (tailcall / JS-linkage / multi-result deferred) | ✅ |
| `CallBuiltinPointerInstruction` emission (placeholder via `Builtins::CppEntryOf`) | ✅ |
| 9 fixtures + goldens in `examples/libs/nodejs/test/torque-fixtures/` | ✅ |
| Fixture harness passes all 9 diffs (byte-exact, portable paths) | ✅ |
| `clang++ -fsyntax-only` check on `return` fixture with minimal shim: clean | ✅ |
| Non-whitelisted output unchanged vs. post-Phase-1 baseline (Task 2.16 diff empty; non-ccbuiltins sha `a5195c0258fd9af9415e9d41f0c2e38237989c1b` matches) | ✅ |
| Consolidated patch (`v8-torque-cc-builtins.patch`, 1235 lines) re-applies cleanly on upstream `9fe7634c` | ✅ |

**CCGenerator stubs remaining for Phase 3:** 3 (`CallCsaMacroAndBranchInstruction`, `MakeLazyNodeInstruction`, `GotoExternalInstruction`).

**Phase 2 commit chain on the Node.js clone** (11 commits on top of Phase 1, tip `b7b4d0c9`):
1. `torque: add --cc-builtins-whitelist CLI flag`
2. `torque: Visit(Builtin*) kCCBuiltins — real emission under whitelist`
3. `torque: implement CCGenerator::Emit(ReturnInstruction)`
4. `torque: implement CCGenerator::Emit(PushUninitializedInstruction)`
5. `torque: implement CCGenerator::Emit(NamespaceConstantInstruction)`
6. `torque: implement CCGenerator::Emit(PushBuiltinPointerInstruction)`
7. `torque: implement CCGenerator::Emit(StoreReferenceInstruction)`
8. `torque: implement CCGenerator::Emit(StoreBitFieldInstruction)`
9. `torque: implement CCGenerator::Emit(CallRuntimeInstruction)` (also adds `RuntimeFunction::ShouldBeInlined` override — see deviation note below)
10. `torque: implement CCGenerator::Emit(CallBuiltinInstruction)`
11. `torque: implement CCGenerator::Emit(CallBuiltinPointerInstruction)`

**Sample output** (`test/torque-fixtures/golden/return-tq-ccbuiltins.cc`):

```cpp
// AUTO-GENERATED by torque CC-Builtins backend (Phase 1 scaffolding).
// Source: test/phase2-fixtures/return.tq
// DO NOT EDIT.

namespace v8::internal {

Tagged<Smi> Builtin_TorqueCcTest_Return(Isolate* isolate, Tagged<Context> context, Tagged<Smi> arg) {
  USE(isolate);
  Tagged<Context> parameter0 = context;
  USE(parameter0);
  Tagged<Smi> parameter1 = arg;
  USE(parameter1);
  goto block0;

  block0:
  return parameter1;
}

}  // namespace v8::internal
```

### Plan deviations surfaced during Phase 2 implementation

- **`out/Release.baseline/torque`, NOT `out/Release/torque`.** The Phase 2 plan initially referenced `out/Release/` (lite-mode build per Phase 0 CSS+jitless gate). Changed throughout the plan before dispatching subagents: lite-mode torque lacks `V8_ENABLE_WEBASSEMBLY` → cannot parse `wasm-objects.tq`. Stock `Release.baseline/` is what Phase 1 actually used; Phase 2 plan corrected to match.
- **Stock `.tq` file list regex was too narrow.** Phase 1 plan used `grep -oE '"src/[^"]*\.tq"'` which matches 243 files — missing `test/torque/test-torque.tq` and `third_party/v8/builtins/array-sort.tq`. Correct pattern: `'"(src|test|third_party)/[^"]*\.tq"'` → 245 files (matches verification.md's documented count). Missing these two files triggers `cannot find SortState` during torque runs over the "full fileset".
- **Host-path portability in generated `// Source:` comments.** Torque's `SourceFileMap::AbsolutePath` emits a `file://` URI for any input not prefixed by `-v8-root`. Task 2.5's first run committed a golden with `// Source: file:///Users/brandon/...` — unusable in CI. Fixed by pulling forward Task 2.14's harness wiring: fixtures are now symlinked into `$NODE_SRC/deps/v8/test/phase2-fixtures/<name>.tq` and passed as v8-root-relative paths, producing stable `// Source: test/phase2-fixtures/<name>.tq` comments.
- **`Callable::ShouldBeInlined` default broke `RuntimeFunction` calls inside builtins.** Phase 1's Task 1.5 had the `Callable` base return `true` for `kCCBuiltins` (to suppress non-Builtin declarables in the fourth pass). When Task 2.4's real-emission path started actually driving a builtin body through CCGenerator, builtin→RuntimeFunction calls hit `GenerateCall`'s `inline_macro=true` path and silently dropped arguments. Fix: added `RuntimeFunction::ShouldBeInlined` override returning `false` for `kCCBuiltins` (mirrors the existing `Builtin::ShouldBeInlined` override). Macros and Intrinsics inherit the default `true`, which works correctly since they CAN be inlined — but a future fixture that exercises an Intrinsic in a surprising way may need the same override. Watch for it.
- **Plan's "uninitialized" keyword fixture doesn't exist.** Task 2.6's plan draft suggested `const x: Smi = uninitialized;`, but Torque has no `uninitialized` keyword. `PushUninitializedInstruction` is emitted by uninitialized `let` declarations (`let x: T;` with no initializer, per `implementation-visitor.cc:900`). Fixture uses `let x: Smi; x = arg; return x;`.
- **`PushUninitializedInstruction.type` is `TopType`, not the underlying type.** Its `GetRuntimeType()` would fail (TopType's `GetGeneratedTypeNameImpl` is `UNREACHABLE`). Emission unwraps via `TopType::DynamicCast(...)->source_type()` before calling `GetRuntimeType()`.
- **`BuiltinPtr extends Smi`.** `instruction.type->GetRuntimeType()` for PushBuiltinPointer resolves to `Tagged<Smi>` (not `Tagged<BuiltinPtr>` — Smi-subtype branch fires first in `Type::GetRuntimeType`). No cast wrapper needed; the generated code uses `Smi::FromInt(static_cast<int>(Builtin::k…))` directly.
- **Extern builtins cannot be used as pointer targets.** Task 2.8's first attempt used `extern builtin` as the referenced builtin; Torque rejects function pointers to external/non-stub linkage (`implementation-visitor.cc:1120`). Fixture defines both caller and target internally.
- **Plan's `StoreReferenceInstruction` draft referenced a non-existent `synchronization` field.** `instructions.h:397-401` shows the instruction has only `type`. Only plain `TaggedField<T>::store` / `WriteField<T>` are emitted. No `Relaxed_` / `Release_` variants because Torque doesn't expose them for stores.
- **Pre-existing CallIntrinsic crash on empty `constexpr_arguments`.** `ProcessArgumentsCommon` at `cc-generator.cc:160-180` segfaults in `constexpr_arguments.back()` when the vector is empty but `parameter_types` still expects a constexpr. Not introduced by Phase 2 — surfaced when a fixture implicitly used `%FromConstexpr` for integer literals. Fixtures pick shapes that avoid this (e.g., pass values via parameters instead of literals, use `torque_internal::unsafe::NewReference<Smi>(obj, offset)` to avoid field-offset lowering).
- **Harness staging pulled forward from Task 2.14.** The plan had Task 2.14 wire the whitelist CSV and leave staging implicit. Committed in Task 2.5 alongside the first real fixture so every golden from the start has portable paths.
- **`clang++ -fsyntax-only` scope limited to `return` fixture only.** Per the plan, this task's acceptance bar was "the return fixture parses". Fuller parse-checks of the more complex goldens (Union types, std::tie tuple assignments between related Tagged subtypes) would require a richer V8-like shim or the real V8 tree; deferred to Phase 4 when the dispatch table lands.

### Phase 2 follow-ups for later phases

- **`Builtins::CppEntryOf` is a placeholder.** Task 2.13's CallBuiltinPointer emission refers to `Builtins::CppEntryOf(Builtin)` — this symbol does not exist in V8. Phase 4 must generate `builtins-cc-table.inc` with real function-pointer lookup.
- **JS-linkage builtins emit only a comment.** Task 2.4's gate skips them with `(JS linkage deferred to Phase 3)`. Phase 3 must implement the JS builtin ABI (receiver/newTarget/dispatchHandle parameter unpacking, Descriptor machinery).
- **Bridge-line scaffolding for parameter naming.** `Visit(Builtin*)` emits `<Type> parameterN = <torque_name>;` inside each generated body because `AddParameter` hard-codes the `parameterN` stack convention. A future refactor could teach `AddParameter` an override-name mode so the Torque names flow directly into the emitted C++. TODO in place at `implementation-visitor.cc:~640`.
- **Intrinsic/Macro `ShouldBeInlined` may need the same treatment as RuntimeFunction.** Current fixtures don't exercise it, but a future fixture that calls an intrinsic could surface the same argument-drop bug. Easy fix when it comes up.

**Next:** Phase 3. Write `docs/plans/2026-04-20-torque-cc-backend-phase3.md` covering the 3 hard instructions — `CallCsaMacroAndBranchInstruction` (DESIGN RISK — signature rewrite for labels), `MakeLazyNodeInstruction`, `GotoExternalInstruction`. Spike `CallCsaMacroAndBranch` first per the handoff doc.

## Phase 3 Spike Decisions (Task 3.3)

**Spike fixture.** `GotoIfForceSlowPath()` from `deps/v8/src/builtins/base.tq:1622` — `extern macro GotoIfForceSlowPath(): void labels Taken;`. Simplest labeled extern macro in the stock V8 fileset: zero args, `void` return, one label with no label-value parameters. Fixture wrapped it in a whitelisted `TorqueCcTest_SpikeCcMab` builtin invoking `GotoIfForceSlowPath() otherwise Bailout`.

**Pre-existing Phase 2 crash found.** Running the spike under `--cc-builtins-whitelist=TorqueCcTest_SpikeCcMab` did NOT emit the expected `ReportError("Not supported in C++ output: CallCsaMacroAndBranch")` — it SIGSEGVed (exit=139). Stack: `ContextualVariable<CurrentSourcePosition, SourcePosition>::Scope::Scope` at `contextual.h:40`, `value_(std::forward<Args>(args)...), previous_(Top())`. Root cause: Phase 2's real-emission path in `Visit(Builtin*)` establishes `CurrentScope`, `CurrentCallable`, and `CurrentReturnValue` scopes, but omits `CurrentSourcePosition`. When `GenerateCall` → `ReportError` path tries to attach a source position, `Top()` dereferences a dangling reference. Fixing this (adding `CurrentSourcePosition::Scope source_position(builtin->Position())` alongside the other scopes at `implementation-visitor.cc:~620` under the whitelist branch) is a precondition for any Phase 3 instruction-emission work — without it, torque crashes before any CCGenerator `EmitInstruction` ever runs. Tracked as Task 3.3a.

**CallCsaMacroAndBranch emission strategy: full A (out-param rewrite).** Callee signature rewrite: for each label, `f.AddParameter("bool*", ExternalLabelName(...))` + per-label-value `f.AddParameter(type->GetRuntimeType() + "*", ExternalLabelParameterName(...))`. Caller declares `bool branch_<label> = false; T out_<label>_<i>{};`, invokes the callee with the pointers, and dispatches with `if (branch_<label>) goto <label_block>;` + fallthrough to the return continuation. Non-void return values flow through normal stack/phi machinery alongside the branch dispatch. Multi-label and label-with-value shapes are supported — not deferred. Rationale: stock V8 builtins use `Cast<HeapObject>(x) otherwise Slow`, `TryGetElement(...) otherwise NotFound(intptr)`, `otherwise Slow, Fast` multi-label patterns extensively; A-narrow would force return-visits to cc-generator.cc the first time Phase 4/5 whitelists a builtin using these shapes.

**GotoExternal emission strategy: full implementation.** Builtins themselves cannot carry labels: Torque's grammar at `deps/v8/src/torque/torque-parser.cc:2930-2934` has the `builtin` rule with NO `optionalLabelList` slot, unlike the `macro` rule at 2925-2929. Confirmed by parse-rejection: fixture `builtin TorqueCcTest_SpikeGotoExt(...) labels Overflow { ... }` fails with `Torque Error: Parser Error: unexpected token "labels"`. Combined with `InlineMacro` (`implementation-visitor.cc:3100-3107`) flattening labeled Torque macros' `goto ExternalLabel` into ordinary `GotoInstruction`s bound to the caller's blocks, `GotoExternalInstruction` is **unreachable in a kCCBuiltins-emitted builtin's CFG**. HOWEVER, Task 3.6 widens `Macro::ShouldBeInlined` to return `false` for labeled Torque macros under kCCBuiltins (so a standalone labeled-macro function is emittable and callable from builtins). That path DOES surface `GotoExternal` inside the macro's own body. Full emission: write each popped value into its `T*` out-param, write `true` into the `bool*` branch indicator, `return;`.

**MakeLazyNode emission strategy: full implementation.** Lambda `[=]() { return <callee>(isolate, <captured args>); }`, mirroring CSA's `csa-generator.cc:490-523` pattern but replacing `state_` with `isolate`. Result type derived from `instruction.result_type->GetRuntimeType()` (typically `std::function<Tagged<T>()>` for `Lazy<T>`). Fixture probes actual firing via `%MakeLazy<>` / `Lazy<T>` Torque constructs. If Torque's surface for lazy-node creation differs from expectation, Task 3.4 adjusts the fixture until `MakeLazyNodeInstruction` appears in `-annotate-ir` output.

**Signature rewrite scope.** Only `OutputType::kCCBuiltins`. The existing `kCC` / `kCCDebug` paths keep the `ReportError("Macros that generate runtime code can't have label exits")` gate at `implementation-visitor.cc:2056-2058`. Hand-written V8 C++ that calls kCC-emitted macros is untouched. Under kCCBuiltins, a new branch in `GenerateFunction` emits the out-param form when `signature.labels` is non-empty.

**`Macro::ShouldBeInlined` overrides.** Phase 3 adds two conditional inline-suppressions for kCCBuiltins: (i) labeled extern macros (`IsExternal() && !labels.empty()`) always go through the CallCsaMacroAndBranch path (extern macros can't be inlined anyway); (ii) labeled Torque macros (`!IsExternal() && !labels.empty()`) go through the CallCsaMacroAndBranch path so the macro body is emitted as a standalone function with the out-param signature, making `GotoExternal` reachable inside that body. Unlabeled macros continue to inline under the base-class default (stays `true`). Mirrors Phase 2's `RuntimeFunction::ShouldBeInlined` → false override.

**Follow-ups explicitly deferred from Phase 3 (not in scope):**
- `catch_block` / runtime exception handling on any of CallCsaMacroAndBranch / CallRuntime / CallBuiltin — needs its own design (C++ exceptions vs. `expected<T,E>` vs. Torque error channel). Phase 4+.
- Tail-calls from `CallBuiltin` / `CallBuiltinPointer` — Phase 4+.
- JS-linkage builtin emission (receiver/newTarget/dispatchHandle ABI, Descriptor machinery) — Phase 3+.
- `builtins-cc-table.inc` dispatch table — Phase 4.

## Phase 3 Summary

| Item | Result |
|---|---|
| Spike findings + strategy decision committed (Task 3.3) | ✅ |
| Phase 2 latent crashes fixed (3 holes surfaced by Phase 3 probing) | ✅ |
| `MakeLazyNodeInstruction` emission (`std::function<T()>` lambda) | ✅ |
| `CallCsaMacroAndBranchInstruction` emission (full A: out-param rewrite) | ✅ |
| `GotoExternalInstruction` emission (defensive — Phase 4 exercises it) | ✅ |
| `Macro::ShouldBeInlined` override for labeled non-extern macros under kCCBuiltins | ✅ |
| `ExternMacro` + `Intrinsic` `ShouldBeInlined` overrides for kCCBuiltins | ✅ |
| `CurrentSourcePosition::Scope` added to Phase 2's `Visit(Builtin*)` whitelist branch | ✅ |
| 2 new fixtures + goldens (`make-lazy-node`, `call-csa-macro-and-branch`) | ✅ |
| Full 11-fixture harness passes (9 Phase 2 + 2 Phase 3) | ✅ |
| `clang++ -fsyntax-only` parse-check passes for both Phase 3 goldens | ✅ |
| Non-whitelisted output byte-identical to Phase 1/2 baseline (sha `a5195c0258fd9af9415e9d41f0c2e38237989c1b`) | ✅ |
| Consolidated patch (`v8-torque-cc-builtins.patch`, 1736 lines, 75 KB) re-applies cleanly on upstream `9fe7634c` | ✅ |

**CCGenerator stubs remaining after Phase 3: 0.** Every backend-dependent instruction (22 of 22) now has a real emission. Remaining `ReportError` calls in `cc-generator.cc` are intentional scope gates WITHIN instruction implementations (catch-block, tailcall, JS-linkage, multi-result PairT) that Phase 4+ addresses as fixtures force them.

**Phase 3 commit chain on the Node.js clone** (6 commits on top of Phase 2 tip `b7b4d0c9`):
1. `55af7d6d` — `torque: add CurrentSourcePosition::Scope to Visit(Builtin*) kCCBuiltins branch`
2. `9b794e1f` — `torque: ExternMacro + Intrinsic ShouldBeInlined return false for kCCBuiltins`
3. `6cc01195` — `torque: implement CCGenerator::Emit(MakeLazyNodeInstruction)`
4. `e0464526` — `torque: Macro::ShouldBeInlined returns false for labeled macros under kCCBuiltins`
5. `f279deb8` — `torque: implement CCGenerator::Emit(CallCsaMacroAndBranchInstruction)`
6. `33051608` — `torque: implement CCGenerator::Emit(GotoExternalInstruction)`

Total commits on top of upstream `9fe7634c` after Phase 3: **27** (10 Phase 1 + 11 Phase 2 + 6 Phase 3).

### Sample outputs

**`test/torque-fixtures/golden/make-lazy-node-tq-ccbuiltins.cc`** (lambda emission):

```cpp
Tagged<Smi> Builtin_TorqueCcTest_MakeLazyNode(Isolate* isolate, Tagged<Context> context, Tagged<Smi> arg) {
  std::function<Tagged<Smi>()> tmp0;  USE(tmp0);
  // ...
  tmp0 = [=]() { return TqRuntimeTorqueCcTest_LazyBody_0(parameter1); };
  // ...
}
```

**`test/torque-fixtures/golden/call-csa-macro-and-branch-tq-ccbuiltins.cc`** (out-param dispatch):

```cpp
Tagged<Smi> Builtin_TorqueCcTest_CallCsaMacroAndBranch(Isolate* isolate, Tagged<Context> context) {
  bool label0 = false;
  Tagged<Smi> tmp1{}; USE(tmp1);
  // ...
  TorqueRuntimeMacroShims::CodeStubAssembler::GotoIfForceSlowPath(&label0);
  if (label0) { goto block4; }
  goto block3;
  // ...
}
```

### Plan deviations surfaced during Phase 3 implementation

- **Phase 2 had 3 latent crashes** that only manifested when a whitelisted builtin hit real call-lowering paths:
  1. **`ExternMacro::ShouldBeInlined` inherited base `true` for kCCBuiltins** — `GenerateCall` routed extern-macro calls through `InlineMacro`, which null-dereffed `*macro->body()` (extern macros have `body() == std::nullopt`). Fix: override to return `false` for kCCBuiltins, mirroring Phase 2's `RuntimeFunction` fix.
  2. **`Intrinsic::ShouldBeInlined` inherited base `true`** — `GenerateCall`'s `inline_macro=true` path skipped `AddCallParameter`'s `constexpr_arguments` population, leaving the vector empty. Intrinsic handlers (`%MakeLazy`, `%SizeOf`, `%RawConstexprCast`, etc.) then read `constexpr_arguments[0]` out-of-bounds → SIGSEGV in `StringLiteralUnquote` at `implementation-visitor.cc:3272`. Fix: override to return `false` for kCCBuiltins.
  3. **`Visit(Builtin*)` omitted `CurrentSourcePosition::Scope`** — the Phase 2 whitelist branch established `CurrentScope` / `CurrentCallable` / `CurrentReturnValue` but not source-position scope. Without it, any `ReportError` or downstream `CurrentSourcePosition::Scope::Scope` push dereferenced a dangling reference (`contextual.h:40`). Fix: add the missing scope at the top of the whitelist branch.

  All 3 were pre-existing Phase 2 gaps; Phase 3's probing made them reachable and Phase 3's fixes make them disappear. `Builtin::ShouldBeInlined`, `RuntimeFunction::ShouldBeInlined`, `Macro::ShouldBeInlined` now all have kCCBuiltins-aware implementations.

- **Task 3.6 outcome: no fixture for `GotoExternalInstruction`.** The Task 3.3 decision note anticipated that `Macro::ShouldBeInlined = false` for labeled Torque macros would make standalone labeled-macro bodies emittable, surfacing `GotoExternal` inside those bodies. In reality, making the macro "non-inline" only affects the CALLER side (routes to `CallCsaMacroAndBranchInstruction`); it does NOT cause the macro's body to be emitted as a standalone C++ function anywhere — there is no macro-iteration pass under kCCBuiltins, and the kCC pass's `EnsureInCCOutputList` call fires only under kCC/kCCDebug output types. Phase 3's `GotoExternal` emission ships defensively (correct code that will fire when Phase 4 adds the macro-body emission path) but is not exercised by any Phase 3 fixture. Documented in the commit message at `33051608`.

- **Task 3.5 did NOT relax `GenerateFunction`'s label-exit `ReportError`** at `implementation-visitor.cc:2056-2058`. The original plan suggested adding a kCCBuiltins arm emitting `bool*` + `T*` out-params. In practice, `GenerateFunction` under kCCBuiltins is only called for `Builtin` declarables (the fourth-pass filter skips Macros), and Phase 3's CallCsaMacroAndBranch emission constructs the call site directly without going through `GenerateFunction`. The gate relaxation is deferred to Phase 4 when macro-body emission lands.

- **`Lazy<T>::GetRuntimeType()` null-derefs** — Torque's `AbstractType::GetGeneratedTypeName` special-cases `Lazy<T>` but has no `ConstexprVersion`, causing `GetRuntimeType` to deref a null pointer. MakeLazyNode emission uses `Type::MatchUnaryGeneric(result_type, TypeOracle::GetLazyGeneric())` to extract the wrapped `T` and builds `std::function<<T-runtime-type>()>` directly.

- **`ExternMacro::CCName()` resolves to `TorqueRuntimeMacroShims::<asm>::<name>`**, not the default `TqRuntime_<name>`. Virtual dispatch through `CCName()` handles the difference in all Phase 3 emissions (`MakeLazyNode`, `CallCsaMacroAndBranch`) without needing explicit `ExternMacro::DynamicCast` checks in the emission code — simpler than the original plan's explicit branching.

- **Torque fixture syntax: `label Slow { }` clauses must be attached to a `try { }` block**, not placed at the top level of a builtin body. This is Torque grammar, not a bug in our work. Corrected during the CallCsaMacroAndBranch fixture iteration (pattern cribbed from `deps/v8/src/builtins/array-to-spliced.tq:232-240`).

- **`EmitGoto` label-value binding** — CC's `EmitGoto` (`cc-generator.cc:477-489`) iterates `stack->AboveTop()` against `destination->InputDefinitions()` and emits phi assignments. For label-block gotos inside CallCsaMacroAndBranch, we push the label-value slot names onto a local copy of the pre-call stack before calling `EmitGoto`, so the phi mechanism sees the bound values. The current fixture (`GotoIfForceSlowPath`, zero label-value params) doesn't exercise this, but the logic is in place for Phase 4+ multi-value labels.

### Phase 3 follow-ups for later phases

- **Macro-body emission under kCCBuiltins** — required to exercise `GotoExternalInstruction` and to LINK the `TqRuntime_<macro>` calls emitted by `CallCsaMacroAndBranch`. Needs either (a) extending the fourth pass to also iterate labeled macros referenced from whitelisted builtins, or (b) extending the kCC `EnsureInCCOutputList` trigger to fire under kCCBuiltins, or (c) a new sixth pass specifically for kCCBuiltins-callable macros. Paired with a relaxation of `GenerateFunction`'s `implementation-visitor.cc:2056-2058` gate for the kCCBuiltins arm. **Phase 4 scope.**
- **Runtime exception handling** (`catch_block` on CallCsaMacroAndBranch / CallRuntime / CallBuiltin) — still `ReportError`. Needs its own design decision: C++ exceptions, `expected<T,E>`-style returns, or a Torque-specific error channel. **Phase 4+.**
- **Tail-calls from `CallBuiltin` / `CallBuiltinPointer`** — still `ReportError`. **Phase 4+.**
- **JS-linkage builtin emission** (receiver / newTarget / dispatchHandle ABI, Descriptor machinery) — still the `(JS linkage deferred to Phase 3)` comment path in `Visit(Builtin*)`. **Phase 4+.** Despite the comment's "Phase 3" label, the realistic pairing is with the dispatch table work in Phase 4.
- **`builtins-cc-table.inc` dispatch table generation** — the `Builtins::CppEntryOf(Builtin)` reference in `CallBuiltinPointer` emission and the `TqRuntime_<macro>` references in MakeLazyNode / CallCsaMacroAndBranch both need real C++ entries at link time. **Phase 4.**

**Next:** Phase 4. Write `docs/plans/2026-04-20-torque-cc-backend-phase4.md` covering dispatch-table generation, macro-body emission under kCCBuiltins, JS-linkage builtin ABI, and the first host-native end-to-end smoke test (linking a translated builtin into `d8`) per the handoff doc's Phase 4 outline.

## Phase 4 Summary

| Item | Result |
|---|---|
| Phase 4 spike decision committed (strategy: new fifth-pass + curated `AllMacrosForCCBuiltinsOutput` list) | ✅ |
| Macro-body emission under kCCBuiltins (fifth pass in `VisitAllDeclarables`) | ✅ |
| `GenerateFunction` emits out-param signature (`bool*` + `T*`) for labels under kCCBuiltins | ✅ |
| `goto-external` fixture + golden (now exercisable with macro-body emission) | ✅ |
| `call-torque-macro` fixture + golden (exercises labeled TorqueMacro via out-param convention) | ✅ |
| `builtins-cc-table.inc` generation + `Builtins::TorqueCcEntryOf` sibling of `CppEntryOf` | ✅ |
| `CallBuiltinPointer` emission uses `TorqueCcEntryOf` (Phase 2's `CppEntryOf` placeholder retired) | ✅ |
| gyp integration: `torque_outputs_ccbuiltins_cc` + `--cc-builtins-whitelist` plumbing via GYP_DEFINES | ✅ |
| Host CSS+jitless V8 build with patch + whitelist (`build-v8-host-phase4.sh`) | ✅ |
| C++ unit test invokes `Builtin_TorqueCcTest_Return` directly (`TorqueCcBuiltinTest.DirectInvocation` — 3 ms) | ✅ |
| C++ unit test verifies dispatch table (`TorqueCcBuiltinTest.DispatchTableLookup` — 4 ms) | ✅ |
| Full 13-fixture harness passes (11 Phase 2/3 + 2 Phase 4) | ✅ |
| Non-whitelisted torque output sha unchanged vs Phase 3 (`a5195c0258fd9af9415e9d41f0c2e38237989c1b`) | ✅ |
| Consolidated patch exports + re-applies cleanly on upstream `9fe7634c` (42 commits, 2843 lines) | ✅ |

**CCGenerator stubs after Phase 4: 0.** Every backend-dependent instruction emits real C++. Remaining `ReportError` gates are intentional scope gates (catch-block, tailcall, JS-linkage, multi-result PairT, struct-typed label values) that Phase 5+ addresses as fixtures force them.

**End-to-end proof.** `TorqueCcTest_Return(isolate, context, Smi::FromInt(42)) == Smi::FromInt(42)` runs at native speed in a host-linked V8 unit test. `Builtins::TorqueCcEntryOf(Builtin::kTorqueCcTest_Return) == &Builtin_TorqueCcTest_Return` confirms the dispatch table resolves correctly. This is the first phase producing running code rather than source-level fidelity.

**Phase 4 commit chain on the Node.js clone** (15 commits on top of Phase 3 tip `33051608`):
1. `57a1465f` — `torque: add AllMacrosForCCBuiltinsOutput list + accessor`
2. `1afcd23d` — `torque: record TorqueMacros referenced from kCCBuiltins builtins`
3. `181803dd` — `torque: record TorqueMacros referenced by MakeLazyNode under kCCBuiltins`
4. `c1b9e4e2` — `torque: add fifth pass emitting kCCBuiltins-referenced macro bodies`
5. `56d0b70c` — `torque: route kCCBuiltins through VisitMacroCommon + GenerateMacroFunctionDeclaration`
6. `7fdbade5` — `torque: Macro::ShouldBeInlined returns false for all TorqueMacros under kCCBuiltins`
7. `bd86dadb` — `torque: emit out-param signature for labeled macros under kCCBuiltins`
8. `fd0a721a` — `torque: mark kCCBuiltins macro bodies inline via InlineDefinition flag` (reworked from bad commit `905aae7f` that leaked `inline` into stock kCC output)
9. `ca5aeb8d` — `torque: emit builtins-cc-table.inc for kCCBuiltins dispatch`
10. `a7784154` — `v8 builtins: add Builtins::TorqueCcEntryOf sibling to CppEntryOf`
11. `8957403e` — `torque: CallBuiltinPointer uses Builtins::TorqueCcEntryOf`
12. `fae77eb7` — `v8 builtins: clarify TorqueCcEntryOf comment re empty whitelist`
13. `a1754567` — `v8 gyp: compile -tq-ccbuiltins.cc + wire --cc-builtins-whitelist`
14. `8c5e91c0` — `v8: stage TorqueCcTest_Return fixture permanently under test/torque-cc-fixtures/`
15. `2b408bfb` — `v8 torque+node: Phase 4 smoke test — invoke Torque-CC-translated builtin directly`

Total commits on top of upstream `9fe7634c` after Phase 4: **42** (10 Phase 1 + 11 Phase 2 + 6 Phase 3 + 15 Phase 4). Consolidated patch: 2843 lines.

### Plan deviations surfaced during Phase 4 implementation

- **Spike finding 5 required duplicate-emission prevention** (plan Task 4.3). Transitive macros like `FromConstexpr_Smi_constexpr_IntegerLiteral` are emitted in BOTH kCC's `-tq-inl.inc` AND kCCBuiltins' `-tq-ccbuiltins.cc`. Without ODR-legal duplicate definitions, linking multiple TUs containing the same symbol fails. Solution: mark kCCBuiltins bodies `inline`. Initial attempt (commit `905aae7f`) widened `PrintBeginDefinition`'s `inline` emission globally, which leaked into stock `-tq-inl.inc` class-accessor bodies (70 files), shifting the non-ccbuiltins sha. Fix (`fd0a721a`): introduced a separate `InlineDefinition` flag (0x80 in `FUNCTION_FLAG_LIST`) distinct from `SetInline()`. The new flag is set only under kCCBuiltins by `GenerateFunction`; `SetInline()` keeps its original "declaration-header inline" semantics. Cleaner separation of concerns.
- **Widened `Macro::ShouldBeInlined`** from Phase 3's labeled-only carve-out to ALL TorqueMacros under kCCBuiltins. Without this, `ShouldGenerateExternalCode` nulls the stream for the fifth pass and no body emits. Side effect: every macro call in a whitelisted builtin goes through `CallCsaMacroInstruction`/`CallCsaMacroAndBranchInstruction` dispatch rather than inlining — matches kCC discipline.
- **MakeLazyNode needs its own trigger.** It bypasses `GenerateCall` (directly emits the `TqRuntime<name>_<N>(...)` call from the instruction emitter). Without a separate `EnsureInCCBuiltinsOutputList` call in `cc-generator.cc:434`, MakeLazyNode references land without bodies. `CallCsaMacro` and `CallCsaMacroAndBranch` both go through `GenerateCall` — one trigger covers them.
- **Three Phase-3 latent issues surfaced**:
  - `Lazy<T>::GetRuntimeType()` null-derefs (Phase 3 already fixed via `MatchUnaryGeneric`).
  - `VisitMacroCommon` + `GenerateMacroFunctionDeclaration` needed kCCBuiltins arms (plan noted ambiguous line numbers; implementer added proper arms based on actual structure).
  - Struct-typed label values would need emission; guarded as `ReportError("Phase 4: ... not yet supported")` — no fixture forces it yet.
- **Task 4.9 uncovered 2 bugs** that only became reachable once the smoke test linked a real body:
  - **Missing `#include`s in `-tq-ccbuiltins.cc`**. Before Task 4.9 the empty default whitelist hid this. With `TorqueCcTest_Return` whitelisted, the file fails to compile (`'Smi' undeclared`). Fix: `ImplementationVisitor::GenerateImplementation` now emits an include preamble at the top of every `-tq-ccbuiltins.cc` (`src/base/macros.h`, `src/execution/isolate.h`, `src/objects/contexts.h`, `src/objects/smi.h`, `src/objects/tagged.h`). All 13 fixture goldens were refreshed to match.
  - **Builtin enum offset divergence** between `cctest` and `v8_base_without_compiler`. The `V8_ENABLE_LEAPTIERING` conditional in `builtins-definitions.h:72` adds 6 TFC entries. Without the LITE_MODE/LEAPTIERING defines propagated to cctest's gyp target, cctest sees `Builtin::kTorqueCcTest_Return = 1515` while builtins.cc sees it as `1521`. Fix: propagate `V8_LITE_MODE`, `V8_ENABLE_LEAPTIERING`, `V8_ENABLE_SPARKPLUG`, `V8_ENABLE_MAGLEV`, `V8_ENABLE_TURBOFAN`, `V8_INTL_SUPPORT` + V8 include paths to cctest's gyp target.
- **Used Node.js `cctest` target, not V8's `v8_unittests`.** V8's `v8_unittests` is GN-build-only and not wired through Node.js's gyp. Node's `cctest` is gtest-based and autodiscovers files under `test/cctest/` via `configure.py`'s `SearchFiles('test/cctest', 'cc')` — so `test/cctest/test_torque_cc_builtin.cc` is picked up by file placement alone; no explicit gyp registration needed.
- **Default-constructed `Tagged<Context>`** used in `TorqueCcBuiltinTest.DirectInvocation` (null tagged pointer) rather than a real native context — the `TorqueCcTest_Return` builtin body doesn't touch context, and obtaining a real one requires pulling in `isolate-inl.h` which conflicts with `V8_LITE_MODE`'s `feedback-vector.h` expectations. Safe for this fixture; future fixtures that dereference context will need a real `native_context` setup.

### Phase 4 follow-ups for later phases

- **Runtime exception handling** (`catch_block` on CallCsaMacroAndBranch / CallRuntime / CallBuiltin) — still `ReportError`. Needs a dedicated plan. **Phase 5+.**
- **Tail-calls from `CallBuiltin` / `CallBuiltinPointer`** — still `ReportError`. **Phase 5+.**
- **JS-linkage builtin emission** (receiver / newTarget / dispatchHandle ABI + Descriptor machinery) — still the `(JS linkage deferred)` comment path in `Visit(Builtin*)`. **Phase 5+.**
- **`Builtins::code(Builtin)` integration** — the smoke test calls the function directly (not through V8's entry table / interpreter). Wiring translated builtins through `Builtins::code` requires additional kind metadata + embedded builtin bootstrapping. **Phase 5/6.**
- **mksnapshot integration** — current smoke test links in a context where no snapshot serialization crosses a translated builtin. Integration when the snapshot needs to capture Torque-CC builtin pointers. **Phase 5+.**
- **Struct-typed label values.** Phase 4 Task 4.4 reports error on struct label values; single-value shape is sufficient for current fixtures. Real V8 builtins use struct label values (e.g., `Cast<HeapObject>(x) otherwise Slow(Object)` in some paths). **Phase 5 when first fixture forces it.**
- **Latent ninja dep-tracking**: `deps/v8/src/builtins/builtins.cc` textually `#include`s `torque-generated/builtins-cc-table.inc`, but ninja's auto-generated `.d` files don't capture that dependency. Regenerating the .inc via a torque re-run does NOT trigger a rebuild of `builtins.o`. Worked around with `touch builtins.cc` during Phase 4 development. Future fix: declare the dependency in gyp or use `gn refs`. **Phase 5 or infrastructure cleanup.**
- **Feature-flag drift**: the LITE_MODE/LEAPTIERING defines propagated to cctest must stay in sync with V8's `v8_config`. Future V8 uplifts that add new feature flags affecting `BUILTIN_LIST` will require updating this list, or the gtest's dispatch lookup silently returns wrong addresses. **Document in any V8 uplift checklist.**
- **Default-constructed `Tagged<Context>`** in the smoke test — works for `TorqueCcTest_Return`, won't work for context-touching builtins. **Phase 5 when first fixture forces real context.**
- **Phase 5:** wire translated builtins through `Builtins::code(Builtin)` for interpreter dispatch, start the first real d8 `-e "print(1+2)"` smoke test, and build out the hand-written CSA replacement ledger.

---

## Phase 5 Spike — Interpreter Dispatch (Task 5.4, 2026-04-22)

### Dispatch path under jitless + lite-mode

Reading `builtins.cc`, `builtins.h`, `isolate.cc`, `interpreter.cc`, `bootstrapper.cc` end-to-end establishes the following:

- `Builtins::Kind` (`builtins.h:150`) is `{ CPP, TSJ, TFJ, TSC, TFC, TFS, TFH, BCH, ASM }` — no `kTorqueCc` kind exists. Phase 4 added `Builtins::TorqueCcEntryOf(Builtin)` returning our C++ function pointer, but did NOT add a new kind.
- `Builtins::code(Builtin)` (`builtins.cc:149`) returns `Tagged<Code>` from `isolate_->builtin_table()[Builtins::ToInt(builtin)]`. That table is populated during bootstrap from the embedded snapshot blob. The embedded blob STILL contains the CSA-generated code for every Torque-CC-whitelisted builtin — Phase 4's patch emits BOTH kCCBuiltins bodies AND kCSA bodies; it doesn't replace the CSA path, only duplicate it.
- `Builtins::InitializeIsolateDataTables(isolate)` (`builtins.cc:418`) copies `embedded_data.InstructionStartOf(i)` into `isolate_data->builtin_entry_table()[i]`. This is what bytecode handlers in the embedded blob actually load-and-call at dispatch time.
- `SimpleInstallFunction(...)` in `bootstrapper.cc` creates a `JSFunction` whose `Code` field points into the embedded builtin blob — that is the code that runs when user JS calls e.g. `Array.isArray(x)`.
- **There is no runtime C++ layer between the bytecode handler and the builtin call.** The interpreter dispatch is machine code baked into the embedded snapshot; `Builtins::code()` is a C++ API used by C++ callers (compilation, bootstrap, debugging) but NOT by the runtime dispatch of a JS-issued call.

### Cost of the plan's Shape A

"Install a minimal Code object per Torque-CC builtin whose `instruction_start` jumps to the C++ function":

- **Requires generating native machine code** per builtin, per architecture (x86_64, arm64). V8's existing machinery that does exactly this — `TFC(AdaptorWithBuiltinExitFrameN, CppBuiltinAdaptor)` — is generated by mksnapshot via CSA and baked into the embedded blob; it is NOT re-invocable at runtime.
- Allocating a real heap-resident `Code` object at bootstrap (after the embedded blob is frozen) requires:
  - Adding a new `Builtins::Kind::kTorqueCc` value + updating every switch over `Kind` (12 sites found via grep).
  - Plumbing `kTorqueCc` through `BUILTIN_LIST_*` macros so `KindOf(builtin)` returns it.
  - Allocating an `InstructionStream` at bootstrap, storing per-architecture thunk machine code in it, and pointing `Code::instruction_stream` at it.
  - Or: using V8's existing `AdaptorWithBuiltinExitFrameN` logic by re-classifying our builtins as `CPP` at runtime, which requires our emitted C++ function to match the CPP builtin ABI (`Tagged<Object> Builtin_X(int argc, Tagged<Object>* args, Isolate* isolate)` — per `builtins-utils-gen.h`). Our Phase-4 emission produces `Tagged<Smi> Builtin_X(Isolate*, Tagged<Context>, Tagged<Smi>)` — fundamentally different ABI.
- **Rough LoC: ≥800** (bootstrap edits + `Kind` propagation + per-architecture thunk codegen OR ABI-matching re-emission in `Visit(Builtin*)`).
- **Matches Task 5.4's escalation trigger**: "requires generating native assembly for the Code-object instruction_start."

### Cost of the plan's Shape B

"Patch the interpreter's builtin-dispatch path to consult `Builtins::TorqueCcEntryOf` first":

- The interpreter dispatches via machine code in the embedded blob. There is no runtime bytecode-handler C++ frame in the hot call path — `Interpreter::GetBytecodeHandler` (`interpreter.cc:114`) is only used at isolate init to populate the dispatch table. After init, the interpreter's bytecode handlers run as native code that loads and calls addresses from `builtin_entry_table[]`.
- To patch "every builtin-dispatch site," we would have to:
  - Regenerate the embedded builtin snapshot with a modified CSA pass that emits a TorqueCc-check branch at each dispatch site. That reverses Phase 4's design goal (keep V8's generated CSA paths stable + emit alongside).
  - OR overwrite `builtin_entry_table[i]` with a thunk at `InitializeIsolateDataTables` — still requires native-code thunks because the machine code calling convention expects builtin-ABI registers, not the C ABI our function uses.
- **Rough LoC:** comparable to Shape A (≥800) once thunks are factored in.

### The real obstacle: ABI translation

Both shapes reduce to the same core problem: **V8's embedded interpreter invokes builtins via a register-based builtin ABI**; our Torque-CC-emitted C++ functions use the C ABI. No wiring change avoids the need for an ABI-translation thunk. V8 has one (`AdaptorWithBuiltinExitFrameN`) but it calls a `CPP`-shaped function signature, not ours.

Two realistic paths forward:

1. **Path 1 — Re-emit with CPP ABI.** Change `Visit(Builtin*)` to emit functions matching the `BUILTIN(Name, ...)` macro's expansion: `Tagged<Object> Builtin_Name(int argc, Tagged<Object>* args, Isolate* isolate)` accessing params via `BuiltinArguments`. Then register the builtin's entry via the existing `builtin_metadata[i].data.cpp_entry` mechanism and piggyback `AdaptorWithBuiltinExitFrameN`. **Cost:** rewrite the Phase-4 emission path + 13 fixtures + goldens; the Phase-4 DirectInvocation cctest changes shape. Eliminates ABI-thunk work. Still requires a new `Builtins::Kind::kTorqueCc` (or runtime kind override) so the adaptor is selected for translated builtins.

2. **Path 2 — Stop short of full dispatch integration.** Phase 5's cctest smoke test would invoke the translated builtin via a direct C++ call against a real `v8::Context` + `v8::Isolate` (Phase 4's DirectInvocation pattern, extended with a real native context so context-touching builtins work). No interpreter dispatch; no d8 `Array.isArray` execution. Phase 5 closes with: "translated JS-linkage ArrayIsArray call-through a real native context; full interpreter integration deferred." Subsequent phases can take Path 1 at leisure.

### Decision

**Neither Shape A nor Shape B as the plan describes them is achievable within Phase 5's scope without escalating to a large V8 bootstrap surgery or an architecture-specific assembly generator.** The plan's escalation trigger ("Task 5.4 spike concludes Shape A requires... generating native assembly") fires.

**Recommended:** take **Path 2** for Phase 5 — defer end-to-end interpreter dispatch to Phase 6+, preserve Phase 5's cctest target but change its shape from "Array.isArray via Script::Run" to "Array.isArray via direct C++ invocation against a real NativeContext." This keeps Phase 5 shippable; Path 1 (re-emission under CPP ABI) becomes a Phase 6 plan item with clear scope.

**Escalation:** Phase 5 plan's Tasks 5.8 (interpreter dispatch implementation), 5.11 (Script::Run smoke), and Task 5.13's d8 smoke-test list all depend on dispatch integration. Those tasks need re-scoping or deferral. Surfacing to user.

## Phase 5 Spike — Path 1 Plumbing (Task 5.1-revised, 2026-04-22)

Per the Phase 5 (revised) plan at `docs/plans/2026-04-22-torque-cc-backend-phase5-revised.md`, this spike re-tests Path 1 (re-emit with CPP ABI + piggyback V8's `AdaptorWithBuiltinExitFrameN`) before layering on real Torque emission. Path 1 was previously dismissed as "requires a new `Builtins::Kind::kTorqueCc`" — that claim was wrong; a hand-written `CPP(<Name>, JSParameterCount(<N>))` entry reuses the existing `Kind::CPP` with zero Kind-switch edits.

### Spike scope

Hand-wrote a minimal CPP-linkage builtin at `deps/v8/src/builtins/builtins-torquecc-spike.cc`:

```cpp
Address Builtin_TorqueCcSpike(int args_length, Address* args_object,
                              Isolate* isolate) {
  DCHECK(isolate->context().is_null() || IsContext(isolate->context()));
  BuiltinArguments args(args_length, args_object);
  HandleScope scope(isolate);
  return (*args.receiver()).ptr();
}
```

Registered via `CPP(TorqueCcSpike, JSParameterCount(0))` in `builtins-definitions.h` (inserted next to `CPP(ArrayConcat, ...)` at line 464), and added `"src/builtins/builtins-torquecc-spike.cc"` to `v8_base_without_compiler`'s sources list in `BUILD.gn` (picked up by `tools/v8_gypfiles/v8.gyp` via its GN-scraper).

### What the spike validates

| Check | Result |
|---|---|
| Source compiles (`builtins-utils-inl.h` + `BuiltinArguments` + `HandleScope` available) | ✅ |
| `CPP(TorqueCcSpike, ...)` static-init accepts the entry | ✅ |
| `FUNCTION_ADDR(Builtin_TorqueCcSpike)` resolves at link time | ✅ |
| `BUILD_CPP_WITHOUT_JOB` → `BuildAdaptor` runs for `Builtin::kTorqueCcSpike` at mksnapshot time | ✅ (mksnapshot exits 0) |
| `AdaptorWithBuiltinExitFrame0` Code object bakes into `libv8_snapshot.a` | ✅ (d8 links, runs `print(1+2)` under the new snapshot) |
| `Builtins::code(Builtin::kTorqueCcSpike)` resolves post-isolate-init | ✅ (implied — d8 starts cleanly; explicit cctest check omitted due to Isolate-incomplete-type issue under the cctest's minimal include set) |
| cctest `TorqueCcBuiltinTest.TorqueCcSpikePlumbing` passes | ✅ (4/4 tests green: DirectInvocation, DispatchTableLookup, Phase5ScriptRunSmoke, TorqueCcSpikePlumbing) |

### What the spike intentionally defers

**End-to-end adaptor → C dispatch at runtime** is not directly verified by the spike's cctest case. Getting the full Factory-builder + global-property-install + Script::Run path to compile under cctest's minimal include set hit a transitive include collision (V8's `src/tracing/trace-event.h` pulled in through `heap/factory.h` → `heap/heap.h` → `gc-tracer.h` conflicts with Node's `tracing/trace_event_common.h` TRACE_EVENT0 macro, because node_test_fixture.h already pulls in `env-inl.h` which defines the macro). Working around this would require gating the spike test with `#undef TRACE_EVENT0` before the V8 includes, which risks masking real issues.

Instead, end-to-end dispatch will be validated by Task 5.8's d8 `print(Array.isArray([1,2,3]))` probe: that exercises the full interpreter → `builtin_table[kArrayIsArray]` → adaptor → `Builtin_ArrayIsArray` → `BuiltinArguments` unpack → Torque-lowered body → `.ptr()` return chain. If Task 5.8 fails, we'd return here and investigate the dispatch piece in isolation.

### Install mechanism notes for future cctest cases (Task 5.6+)

The plan's Task 5.6 (`JsReturnAdaptorDispatch`) needs a JSFunction bound to a CPP builtin for full-dispatch testing. The Phase-4 cctest file deliberately avoids `-inl.h` headers. A Task-5.6 option: **install TorqueCcTest_JsReturn via bootstrapper-style code in node.cc startup (e.g., a `--expose-torque-cc-fixtures` flag)** so cctest doesn't need the Factory incantation. Or: put the cctest case in a separate translation unit that tolerates the heavier headers. Decided: punt on this decision until Task 5.6; the spike proved Path 1 at the plumbing level, which is what the spike was for.

### Build-system quirks observed (so Task 5.2-5.8 don't re-hit them)

- **Source-file registration:** Adding `"src/builtins/builtins-torquecc-spike.cc"` to `v8_base_without_compiler` in `BUILD.gn` was sufficient — `tools/v8_gypfiles/v8.gyp:1098` scrapes that list via `GN-scraper`, so no separate gyp edit is needed. Good news for Task 5.2/5.5 — torque-emitted `-tq-ccbuiltins.cc` files are already captured via `torque_outputs_ccbuiltins_cc` (Phase 4 addition).
- **cctest requires all whitelisted stub-linkage builtins to be linked:** the empty-whitelist build succeeded for mksnapshot + d8 + libv8, but the cctest build failed with "undefined reference to `Builtin_TorqueCcTest_Return`" until the whitelist was expanded to `TorqueCcTest_Return,TorqueCcSpike`. Phase 4's `TorqueCcTest_Return` is referenced unconditionally by the pre-existing `TorqueCcBuiltinTest.DirectInvocation` case. Task 5.5's empty-whitelist build validation stands, but non-empty whitelists for cctest runs must always include `TorqueCcTest_Return`.
- **Shell gotcha:** the Bash tool runs zsh, not bash, so the plan's `$TQ_FILES` word-splitting idioms need `bash -c '...'` wrapping. Already noted in `/tmp/phase5r-baseline-metadata.txt` for the rest of Phase 5.

### LoC estimate for Tasks 5.2–5.5 real emission

- Task 5.2 (torque TFJ→CPP swap): ~15 LoC in `implementation-visitor.cc:3954` emitter.
- Task 5.3 Step 3a (CCGenerator::kPtrReturn): ~10 LoC in `cc-generator.{h,cc}`.
- Task 5.3 Step 3 (real JS-linkage emission): ~80 LoC in `Visit(Builtin*)` replacing the 8-line deferred comment.
- Task 5.4 (preamble): ~3 LoC (3 include lines).
- Task 5.7 (preamble extension for js-array/js-proxy/runtime): ~6 LoC.

Total V8 emitter-side: ~115 LoC + ~5 LoC for the test fixture `.tq` file. Matches the spike's "the hard work is getting the shape right, not the volume" shape.

### Decision

**Path 1 is viable end-to-end at the plumbing level.** Proceed to Task 5.2 (torque TFJ→CPP swap) without re-scoping. The spike's deferred dispatch verification rolls forward into Task 5.8's d8 probe + Task 5.9's in-process ScriptRun cctest.

**Spike artifacts reverted cleanly.** Clone tip stays at `305050d4` (Task-5.3 post-tip, 43 commits on `9fe7634c`); no clone-side commits from Task 5.1. Worktree gets only this verification.md append.

## Phase 5 (Revised) Summary

| Item | Result |
|---|---|
| Task 5.1 spike: Path 1 hand-written proof-of-life | ✅ |
| Torque-side TFJ → CPP swap in BUILTIN_LIST_FROM_TORQUE (Task 5.2) | ✅ |
| CCGenerator::kPtrReturn mode for CPP-ABI return (Task 5.3) | ✅ |
| JS-linkage CPP-ABI emission in Visit(Builtin*) kCCBuiltins (Task 5.3) | ✅ |
| Include preamble extended (builtins-utils-inl, arguments-inl, handles-inl) (Task 5.4) | ✅ |
| Host build with ArrayIsArray whitelisted (Task 5.8) — mksnapshot + d8 + cctest all green | ✅ |
| TorqueCcBuiltinTest.JsReturnAdaptorDispatch cctest (Task 5.6) | ✅ |
| TorqueCcBuiltinTest.ScriptRunArrayIsArray cctest (Task 5.9) | ✅ |
| d8 smoke — `Array.isArray([1,2,3])` prints "true" (Task 5.10) | ✅ |
| d8 smoke — `Array.isArray(42)` + `Array.isArray({})` print "false" (Task 5.10) | ✅ |
| CSA-replacement ledger scaffold + Path-1-aware README (Task 5.11) | ✅ |
| 15-fixture harness: 13 stub-linkage + 2 JS-linkage, all byte-exact | ✅ |
| Non-whitelisted torque output sha stable post-5.8/5.9: d5c6d835… | ✅ |
| Consolidated patch exports + re-applies cleanly on upstream 9fe7634c | ✅ |
| 5 cctest cases green (DirectInvocation + DispatchTableLookup + Phase5ScriptRunSmoke + JsReturnAdaptorDispatch + ScriptRunArrayIsArray) | ✅ |
| d8 smoke: 10/10 checks green | ✅ |

**End-to-end proof.** `./out/Release/d8 -e 'print(Array.isArray([1,2,3]))'`
prints "true"; `print(Array.isArray(42))` prints "false";
`print(Array.isArray({}))` prints "false". V8's interpreter, running
from the embedded lite-mode snapshot, dispatches through the baked
`AdaptorWithBuiltinExitFrame1` for `Builtin::kArrayIsArray`; the
adaptor marshals the JS calling convention into
`BuiltinArguments(1+4, argp, isolate)`; the adaptor calls our
torque-emitted `Builtin_ArrayIsArray(int, Address*, Isolate*)`; our
function unpacks context + receiver + arg via BuiltinArguments +
`isolate->context()`, runs the Torque typeswitch lowered by CCGenerator,
and returns `True.ptr()` / `False.ptr()` / `runtime::ArrayIsArray().ptr()`.
**This is the first phase where V8's own machinery dispatches to our
generated code through its normal interpreter → builtin_table → Code →
adaptor → C++ path, with zero hand-written V8 bootstrap edits.**

**Phase 5 (revised) commit chain on the Node.js clone** (60 commits total
on top of `9fe7634c`; the planned ≈7 new on top of Phase 4 + Task 5.1-5.3
tip `305050d4` expanded to 17 as Task-5.8 defect fixes and Task-5.9 cctest
landed):
1. `torque: emit CPP(...) for whitelisted JS-linkage builtins` (Task 5.2)
2. `torque: CCGenerator gets kPtrReturn mode for CPP-ABI return path` (Task 5.3)
3. `torque: implement JS-linkage CPP-ABI emission under kCCBuiltins` (Task 5.3)
4. `torque: extend kCCBuiltins include preamble for JS-linkage` (Task 5.4)
5. `v8 torque+node: Phase 5 (revised) — JsReturnAdaptorDispatch cctest` (Task 5.6)
6. `torque: extend kCCBuiltins preamble for js-array/js-proxy/runtime` (Task 5.7)
7. Task 5.8 defect fixes (7 commits):
   - `runtime-macro-shims: add 7 helpers (TaggedToHeapObject/TaggedNotEqual/…)`
   - `torque: %ClassHasMapConstant backend-aware (kCCBuiltins → literal false)`
   - `torque: CCGenerator %RawDownCast emits UncheckedCast<T> for Tagged types`
   - `torque: CCGenerator CallRuntime emits direct Runtime_<name>(argc,args,isolate)`
   - `torque: CCGenerator GotoExternal emits return {} on non-void paths`
   - `torque: kCCBuiltins wraps macro bodies in V8_INTERNAL_DEFINED_<CCName>`
   - `torque: kCCBuiltins preamble gains forward-decls + True_0/False_0 shims`
8. `v8 torque+node: Phase 5 (revised) — ScriptRunArrayIsArray cctest` (Task 5.9)

Consolidated patch: 4577 lines (exceeded the ≈3200-line prediction by
~43%; growth is entirely Task-5.7 preamble extension + Task-5.8 defect
repair, which the original plan scoped as "minor" but which in practice
required real engineering once the first V8 rebuild surfaced the
linkage and codegen gaps).

### Plan deviations surfaced during Phase 5 (revised) implementation

- **d8 banner pollution.** `d8 -e '<source>'` writes the
  "V8 is running with experimental features enabled. Stability and
  security will suffer." banner to **stderr**. `test/d8-smoke.sh` was
  initially written per the plan as `2>&1`, which caused all 10
  probes to FAIL with `actual` containing the banner prefixed to the
  real output. Fix: redirect stderr to `/dev/null` during the probe —
  only real program output is checked against expectations.
- **Non-ccbuiltins anchor drifted from 65b1efc5 (Task 5.7) to d5c6d835
  (post-Task 5.8).** Expected drift — Task 5.8's include-guard wrapping
  (`V8_INTERNAL_DEFINED_<CCName>`) and forward-decl / True_0 / False_0
  preamble additions are all under `kCCBuiltins`, but the total file-
  set byte layout shifted enough to move the sha. Task 5.9 added only
  cctest C++ and did NOT further shift the anchor; `d5c6d835…` is
  stable from Task 5.8 onward.
- **Patch size prediction.** Plan predicted ≈3200 lines; final patch
  is 4577 lines. Delta driven by Task 5.7 preamble extension and the
  7-commit Task-5.8 repair chain (one defect per commit, atomic style
  as requested). No planning failure — the plan explicitly noted "exact
  value TBD after final export."

### Phase 5 (revised) follow-ups for later phases

- **Runtime exception handling** (`catch_block`). Still `ReportError`.
  Phase 6+ when a target forces it.
- **Tail-calls from CallBuiltin / CallBuiltinPointer.** Still
  `ReportError`. Phase 6+.
- **Struct-typed label values.** Still `ReportError`. Phase 6+.
- **mjsunit.** Phase 6.
- **CSA replacement ledger — first real shim.** When d8 / mjsunit
  forces one. Phase 6. Scaffold landed in this phase (Task 5.11) under
  `examples/libs/nodejs/csa-builtins/`.
- **Varargs JS builtins** (`IsVarArgsJavaScript`). Still `ReportError`
  under kCCBuiltins. Phase 6 when a forcing fixture lands.
- **Leaptiering-on dispatchHandle.** Currently emits
  `InvalidDispatchHandleConstant()`. Phase 6+ for
  `V8_ENABLE_LEAPTIERING=true` builds.
- **JSProxy branch of ArrayIsArray exercised via real JS.** Not covered
  by Task 5.9's fixed-receiver cases; needs a `new Proxy(…)` case in
  Phase 6 mjsunit.
- **Proper NamespaceConstant CC emission.** Task 5.8 landed True_0 and
  False_0 as hand-written inline accessors in the kCCBuiltins preamble;
  the proper generator-emitted per-const helpers are deferred to Phase 6+
  when base.tq surfaces more consts reachable from whitelisted builtins.
- **%GetClassMapConstant fast-path.** Task 5.8 reduced %ClassHasMapConstant
  under kCCBuiltins to literal `"false"` (semantic no-op for non-
  UNIQUE_INSTANCE_TYPE classes); a free-function `TorqueClassHasMapConstant<T>()`
  driven by `CLASS_MAP_CONSTANT_ADAPTER` would restore the fast path.
- **Wasm32 cross-compile.** Phase 7+.

## Phase 6 Summary

Phase 6 expanded the kCCBuiltins whitelist from 1 JS-linkage builtin
(`ArrayIsArray`) to 5, adding all four `Number.is*` predicates
(`NumberIsFinite`, `NumberIsNaN`, `NumberIsInteger`, `NumberIsSafeInteger`)
under mjsunit pressure. The first addition (`NumberIsFinite`) surfaced
9 emitter/shim gaps; those gaps were closed once and the remaining
three builtins landed with zero emitter changes (only 3 new shims
across Tasks 6.4-6.6).

| Item | Result |
|---|---|
| Task 6.1: run-mjsunit.sh runner + array-isarray.js pass-list | ✅ |
| Task 6.2: NumberIsFinite whitelisted — 4 new shims + 3 gated emitter edits + `is_cc_builtins_` flag | ✅ |
| Task 6.3: number-is.js deferral documented | ✅ |
| Task 6.4: NumberIsNaN whitelisted — 0 new shims, 0 emitter edits | ✅ |
| Task 6.5: NumberIsInteger whitelisted — 2 new shims (IsInteger + SelectBooleanConstant), 0 emitter edits | ✅ |
| Task 6.6: NumberIsSafeInteger whitelisted — 1 new shim (IsSafeInteger), 0 emitter edits | ✅ |
| Task 6.7: mjsunit pass-list grown to 2 files (array-isarray.js + number-is.js) | ✅ |
| Task 6.8: Exhaustive Phase-6 gates 15 OK / 9 PASS / 18 PASS / 2 PASS / anchor stable | ✅ |
| Task 6.9: wasm-posix-kernel kernel suite re-run — 0 regressions | ✅ |
| 15/15 torque-fixture goldens byte-exact | ✅ |
| Non-ccbuiltins anchor excluding number-tq-csa.cc: **8169724e** (stable across Tasks 6.2→6.6, confirming zero cross-file emitter drift) | ✅ |
| Consolidated patch re-applies cleanly on upstream `9fe7634c` | ✅ |
| 9 cctest cases green (5 Phase-5 + 4 new ScriptRun*Number.is*) | ✅ |
| d8-smoke: 18/18 green (10 Phase-5 + 2 per new builtin) | ✅ |
| mjsunit: 2/2 green (array-isarray.js end-to-end + number-is.js all 4 Number.is* assertions) | ✅ |
| Non-ccbuiltins anchor full sha: 3bf75ed0 → 8801f44c → 3231b187 → b32c846a (each drift isolated to one new CSA-suppression entry; excluding-anchor invariant) | ✅ |

**End-to-end proof.** `./out/Release/d8 mjsunit.js deps/v8/test/mjsunit/number-is.js`
runs to completion with exit 0, empty output. The mjsunit harness's
`assertTrue` / `assertFalse` / `assertEquals` invocations all satisfy;
V8's interpreter dispatches through the baked `AdaptorWithBuiltinExitFrame1`
for each of `Builtin::kNumberIsFinite`, `Builtin::kNumberIsNaN`,
`Builtin::kNumberIsInteger`, `Builtin::kNumberIsSafeInteger`; those
adaptors call into the torque-emitted `Builtin_NumberIs*(int, Address*, Isolate*)`
functions; the functions execute their lowered Torque bodies against
real `NativeContext` / `BuiltinArguments` / `ReadOnlyRoots` state.
**Phase 6 is the first phase where mjsunit exercises our emitted code
through V8's full harness-driven test infrastructure**, not just
DirectInvocation cctest and single-expression d8 probes.

**Phase 6 clone commit chain** (77 commits total on top of `9fe7634c`;
11 new on top of Phase-5 tip `b046aa14`):

Task 6.2 (6 commits):
1. `d26ac6da torque: extend kCCBuiltins runtime-macro-shims for NumberIsFinite` — Float64Sub, Word32BinaryNot, TaggedToSmi, BranchIfFloat64IsNaN.
2. `d4ece550 torque: CCGenerator gains is_cc_builtins_ flag + preamble isolate-inl` — scaffolding for the 3 gated emitter edits that follow.
3. `2bf63c6f torque: CCGenerator emits UncheckedCast for UnsafeCast on Tagged types` — fixes the static_cast narrowing failure (Tagged<JSAny> → Tagged<HeapObject>-ish).
4. `531d5fd7 torque: CCGenerator emits Isolate::Current() for NamespaceConstant` — fixes True_0/False_0 undeclared `isolate` in nested helper scope.
5. `3b06c4f2 torque: CCGenerator routes non-tagged ReadField via UncheckedCast<HeapObject>` — fixes HeapNumber::ReadField on V8_OBJECT layout.
6. `81c0fb58 cctest: add ScriptRunNumberIsFinite` — 11 subcases.

Task 6.4 (1 commit):
7. `211cafdf cctest: add ScriptRunNumberIsNaN` — 11 subcases.

Task 6.5 (2 commits):
8. `8c31ae38 runtime-macro-shims: add IsInteger + SelectBooleanConstant for NumberIsInteger`.
9. `c8602fc2 cctest: add ScriptRunNumberIsInteger` — 15 subcases.

Task 6.6 (2 commits):
10. `fcd5e3f1 runtime-macro-shims: add IsSafeInteger for NumberIsSafeInteger`.
11. `2c27a163 cctest: add ScriptRunNumberIsSafeInteger` — 17 subcases.

Patch line growth: 4577 (Phase-5 close) → 5029 (6.2) → 5095 (6.4)
→ 5243 (6.5) → 5374 (6.6 close). Average +160 lines per new builtin;
well under the plan's 6000-line target for Phase-6 close.

**Non-ccbuiltins anchor recipe** (so future phases can reproduce):
```bash
cd examples/libs/nodejs/build/node
# Full anchor (drifts as new builtins whitelisted → their -tq-csa.cc suppressed):
(find out/Release/gen/torque-generated \( -name "*-tq-csa.cc" -o -name "*-tq-ccdebug.cc" \) | sort | xargs cat) | shasum -a 256 | head -c 8
# Excluding suppressed builtins' source file — the load-bearing invariant:
(find out/Release/gen/torque-generated \( -name "*-tq-csa.cc" -o -name "*-tq-ccdebug.cc" \) -not -name "number-tq-csa.cc" | sort | xargs cat) | shasum -a 256 | head -c 8
```
The excluding-anchor value `8169724e` was stable across Tasks 6.2-6.6
(every rebuild after landing NumberIsFinite through NumberIsSafeInteger).
If it drifts in a future task, that signals an emitter regression
affecting some `.tq` source other than the one being whitelisted — a
hard-stop per the plan's Appendix B.

### Plan deviations surfaced during Phase 6 implementation

- **First-subagent time budget blowup (Task 6.2).** The initial
  Task-6.2 subagent invocation consumed its 100+ tool-use budget on
  `tail -N` polls of an incrementally-buffered `ninja` pipe, returning
  zero commits. Pivoted to running the rebuild foreground via
  `Bash(run_in_background: true) + TaskOutput(block: true)`, then
  dispatching a subagent with the 9 errors pre-analyzed. Task-6.2
  subagent then closed cleanly. Subsequent tasks (6.4-6.6) used the
  same "foreground build + incremental Edit/Bash" pattern, which
  proved both faster (no per-task subagent boot) and more reliable
  (no pipe-buffer pathologies).
- **mjsunit test path correction (Task 6.7).** The plan had the test
  at `es6/number-is.js`; V8 actually has it at the mjsunit root
  `number-is.js`. Fixed in Task 6.7's commit message.
- **cctest commit-body attribution imprecision (Task 6.4).** The
  commit body claimed NumberIsNaN reuses `BranchIfFloat64IsNaN`
  directly; the generated code actually calls a torque-emitted helper
  `TqRuntimeFloat64IsNaN_0` which internally uses `BranchIfFloat64IsNaN`.
  Not a correctness issue; the load-bearing claim "build green with
  zero new shim/emitter changes" is accurate. Flagged in the Task-6.4
  review; grep-the-emitted-.cc pattern used for subsequent commits.
- **No emitter regression after 4 whitelist expansions.** The plan
  anticipated possible emitter cascades. None fired — Task 6.2's
  3 emitter edits (UnsafeCast, NamespaceConstant, ReadField) were
  sufficient for the entire `Number.is*` family. Future families
  (Array.*, String.*) may surface new emitter paths.

### Phase 6 follow-ups (status of each Phase-5 deferred item)

| Item | Phase-5 status | Phase-6 status |
|---|---|---|
| Runtime exception handling (`catch_block`) | ReportError | **Still deferred** — no Phase-6 target forced it. Retained for Phase 7+. |
| Tail-calls from CallBuiltin / CallBuiltinPointer | ReportError | **Still deferred** — same reason. |
| Struct-typed label values | ReportError | **Still deferred** — same reason. |
| Varargs JS builtins (`IsVarArgsJavaScript`) | ReportError | **Still deferred** — `BooleanConstructor`, `ArrayOf`, `ArrayFrom` etc. blocked here. Phase 7+ candidate, possibly its own sub-phase. |
| Proper NamespaceConstant CC emission | Hand-written True_0/False_0 | **Advanced** — Task-6.2 change to emit `Isolate::Current()` makes the pattern work in all call-site scopes (outer builtin + nested helpers). Hand-written True_0/False_0 remain; generator-emitted per-const helpers still Phase 7+. |
| `%GetClassMapConstant` fast-path | Literal `false` | **Still deferred** — Phase 6 didn't surface a whitelisted builtin using UNIQUE_INSTANCE_TYPE classes. Phase 7+. |
| CSA-replacement ledger first real shim | Scaffold only | **Still deferred** — all 4 Phase-6 builtins had full Torque sources; no CSA-only shims needed. Ledger README updated is pending the first real shim. |
| mjsunit | Deferred | **Landed** — 2-file pass-list (array-isarray.js + number-is.js). Runner at `examples/libs/nodejs/test/run-mjsunit.sh`. |

### Important follow-ups from Phase-6 code review (non-blocking, flagged for Phase 7)

- **I-1: `Isolate::Current()` on every NamespaceConstant call-site.** Each builtin invocation now reads TLS twice (one per True_0/False_0 return). Alternatives: track scope and emit `(isolate)` in outer builtin bodies, or move TLS acquisition inside the helper inlines. Current emission is semantically correct (Isolate::Current() has a DCHECK that always holds during JS execution); performance impact is in the single-digit nanoseconds range per return. Revisit when a hotter path lands.
- **I-2: `is_cc_builtins_` flag should be a constructor argument.** Currently a setter (`SetIsCCBuiltins(true)`) is called at each of 3 construction sites in `implementation-visitor.cc`. A 4th future site that forgets the setter will silently emit kCC-style output into a kCCBuiltins file, yielding errors that look identical to "missing shim." Promote to a ctor arg or fold into a single `OutputMode` enum. Cleanup candidate for Phase 7 kickoff.

### What Phase 6 proves

- The emitter is now capable of handling JS-linkage builtins whose
  Torque source uses the following shapes without any further
  per-shape emitter edits:
  - `typeswitch (JSAny) { case (Smi): …; case (HeapNumber): …; case (JSAnyNotNumber): …; }`
  - `return SelectBooleanConstant(pure_predicate(value));`
  - `extern macro F(HeapNumber): T` where F reads `value_` from a V8_OBJECT-layout class.
  - Any mix of the above with True_0/False_0 returns in nested helpers.
- The shim layer is the load-bearing surface for expanding whitelist
  coverage. Each new builtin typically costs 0-2 new shims (average
  0.75 across Phase 6's 4 builtins). The emitter has not required a
  new gate past Task 6.2.
- Zero kernel/host/scripts-layer regressions. All 5 wasm-posix-kernel
  kernel gates match main-branch state (including the 2 pre-existing
  vitest environmental failures and the 2 pre-existing libc-test
  FAILs unrelated to Phase 6).

## Phase 7 Summary

Plan: docs/plans/2026-04-24-torque-cc-backend-phase7-tailcalls.md.
Scope: tail-call emission for `CallBuiltinInstruction` (CSA's `TailCallBuiltin` equivalent under kCCBuiltins).

### Emitter change (one branch, 19 lines)

`CCGenerator::EmitInstruction(const CallBuiltinInstruction&, ...)` at
`deps/v8/src/torque/cc-generator.cc:525` gained a tail-call branch that
replaces the prior `ReportError("Phase 2: CallBuiltin tail-call is
deferred.")`. Emission shape:

```cpp
if (instruction.is_tailcall) {
  if (instruction.builtin->IsJavaScript()) ReportError(...Phase 8...);
  if (instruction.catch_block) ReportError(...deferred...);
  std::vector<std::string> arguments = stack->PopMany(instruction.argc);
  out() << "  return Builtin_" << instruction.builtin->ExternalName()
        << "(isolate";
  for (const auto& arg : arguments) out() << ", " << arg;
  out() << ");\n";
  return;
}
```

The two other guards (JS-linkage, catch_block) **remain** as
`ReportError`s below the tail-call branch for the non-tail path, and
are re-emitted inside the tail branch as deferred-to-Phase-8 guards.
The early `return` ensures no result-var decl or non-tail emission
runs when `is_tailcall=true`. Clone commit `6178a949`.

### Synthetic forcing target

`test/torque-cc-fixtures/tail-call.tq` (staged into both the clone's v8
tree and the worktree harness) defines:

```torque
namespace test_cc_tail {
  builtin TorqueCcTest_TailCall_Helper(implicit context: Context)(x: Smi): Smi {
    return x;
  }
  builtin TorqueCcTest_TailCall(implicit context: Context)(arg: Smi): Smi {
    tail TorqueCcTest_TailCall_Helper(arg);
  }
}
```

Golden (`test/torque-fixtures/golden/tail-call-tq-ccbuiltins.cc`) shows
the caller emitting a single terminal `return Builtin_...Helper(isolate,
parameter0, parameter1);` after the standard `goto block0` preamble,
with no `Tagged<Smi> tmp{}` result-var decl — exactly the CSA tail shape
we wanted.

### Real forcing target — DEFERRED to Phase 7A

`Increment` (number.tq:776-785) was the candidate. Triage:

- **Emitter** handles Increment cleanly. A standalone `torque
  --cc-builtins-whitelist=Increment` run produces
  `number-tq-ccbuiltins.cc::Builtin_Increment` with the new tail-call
  at `block5: return Builtin_Add(isolate, parameter0, tmp1, tmp4);` as
  expected. No emitter error; no ReportError hit.
- **Linker surface** is the blocker. Increment's emission calls into 5
  not-yet-shimmed helpers: `TqRuntimeUnaryOp1_0` (port of the
  multi-arm typeswitch macro that dispatches JSAny → Number/BigInt
  via `NonNumberToNumeric`), plus `TqRuntimeFromConstexpr_Number...`,
  `TqRuntimeFromConstexpr_Operation...`, `TqRuntimeSmiTag_Operation_0`,
  and the transitive `Builtin_Add`. Porting `UnaryOp1` alone is
  non-trivial (full typeswitch + `NonNumberToNumeric`), and each
  additional shim compounds the surface.

Per plan's Task 7.4 triage: `Increment`'s callee `Add` is
`transitioning` (number.tq:397) AND `Increment` itself uses `try/label`
dispatch. Both match the plan's "STOP here, mark this task BLOCKED,
skip to Task 7.6. Ship Phase 7 on synthetic fixture + emitter + cctest
only." Phase 7A will resume with either (a) enough CSA-replacement
shims to link Increment, or (b) a simpler forcing target discovered
later (Decrement shares Increment's shape; other candidates in
number.tq tail into runtime/namespace functions not CallBuiltin).

### Verification

| Gate | Phase 6.1 | Phase 7 | Delta |
|------|-----------|---------|-------|
| Torque fixtures | 15/15 byte-exact | **16/16 byte-exact** | +1 new golden (`tail-call`) + 15 refreshed for Phase-6.1 True_0/False_0 drift that hadn't been captured in the baseline |
| cctest `TorqueCcBuiltinTest.*` | 9 PASS | **10 PASS** | +1 `DirectInvocationTorqueCcTest_TailCall` |
| d8-smoke | 18 PASS | **18 PASS** | 0 (no real target shipped) |
| mjsunit | 2 PASS | **2 PASS** | 0 (no real target shipped) |
| Excluding-anchor (`number-tq-csa.cc` excluded) | `8169724e` | `09b34bf8` | **Matching source change**: added `tail-call.tq` to BUILD.gn for cctest linkage, generating a new `tail-call-tq-csa.cc`. With *both* `number-tq-csa.cc` and `tail-call-tq-csa.cc` excluded, anchor stays `8169724e` — confirming no other CSA-emitter drift. |
| Patch delta | 5591 lines (73 commits) | **5753 lines (75 commits)** | +162 lines; under the ≤500-line cap for synthetic-only |
| cargo unit tests | 722 passed | **722 passed** | 0 |
| vitest | 250 passed / 108 skipped | **250 passed / 108 skipped** | 0 |
| libc-test | 0 unexpected FAIL | **0 unexpected FAIL** | 0 (XFAIL set unchanged) |
| POSIX | 0 FAIL, 1 XFAIL | **0 FAIL, 1 XFAIL (munmap/1-1)** | 0 |
| ABI snapshot | In sync | **In sync** | 0 (no ABI surface touched) |

### Harness dedup fix (`run-torque-fixtures.sh`)

Adding `tail-call.tq` to `BUILD.gn` (required for cctest linkage — the
Release build only emits `-tq-ccbuiltins.cc` for files in the
`torque_files` list) introduced a duplicate: the harness passed the
stock copy (`test/torque-cc-fixtures/tail-call.tq`) *and* the staged
worktree copy (`test/phase2-fixtures/tail-call.tq`) to torque, and
`tail TorqueCcTest_TailCall_Helper(arg)` saw two candidates → overload
ambiguity error. `return.tq` and `js-return.tq` avoided this
historically by not self-referencing. Harness now drops stock entries
whose basename matches any fixture, regardless of symlink state —
this is the same drop the pre-existing "symlinked V8-tree fixture"
branch already performs for `array-isarray.tq`.

### Clone commits (75 total on `9fe7634c`)

- `5c894bb8` — v8: stage tail-call.tq fixture in deps/v8/test/torque-cc-fixtures/ + BUILD.gn
- `483afad8` — cctest: add DirectInvocationTorqueCcTest_TailCall
- `6178a949` — torque: CCGenerator emits tail-call for non-JS, non-catch CallBuiltin

### Deferred items still open after Phase 7

| Item | Why deferred |
|------|--------------|
| `catch_block` runtime exception handling (cc-generator.cc:531 + :1121) | Blocks many transitioning builtins (Increment's blocker). Phase 8 candidate. |
| Varargs JS builtins (`IsVarArgsJavaScript`) | Blocks `FastConsoleAssert`, `ArrayOf`, `ArrayFrom`, `Boolean*`, `NumberParse*`, `NumberPrototypeToString`. Phase 8+ candidate. |
| `CallBuiltinPointer` tail-call | Matches CSA's own rejection (`csa-generator.cc:634`). Unlikely to ever become non-deferred. |
| JS-linkage `CallBuiltin` tail-call | Would need `TailCallJSBuiltin`-equivalent CPP-to-JS-linkage trampoline. Phase 8+; no target forces it yet. |
| Multi-result `PairT` return from `CallBuiltin` (cc-generator.cc:548) | No target forces it in Phase 7. |
| Struct-typed label values | ReportError from Phase 4. |
| Generator-emitted per-const `NamespaceConstant` helpers | Phase 6.1 I-1 leaves the hand-written `True_0`/`False_0` pattern. |
| `%GetClassMapConstant` fast-path | Phase 5 compromise; no UNIQUE_INSTANCE_TYPE target forced it. |
| CSA-replacement ledger first real shim | Scaffold at `examples/libs/nodejs/csa-builtins/`. Pending first real need (likely Phase 7A Increment shim: UnaryOp1). |
| Wasm32 cross-compile of the Torque-CC toolchain | Phase 8+. |
| **NEW:** Phase 7A — ship `Increment` (or simpler tail-call target) | Needs `UnaryOp1` shim port + 3-4 supporting `FromConstexpr/SmiTag/Cast` shims. Emitter is ready. |

### What Phase 7 proves

- The emitter handles `CallBuiltinInstruction::is_tailcall=true` correctly
  for non-JS-linkage, non-catch_block builtins: terminal `return` of a
  direct `Builtin_<Callee>(isolate, args...)` call, no intermediate
  result variable. Semantically equivalent to CSA's `TailCallBuiltin`.
- Real-world emission is unblocked: Increment emits cleanly end-to-end;
  the only thing blocking shipping it is the shim layer (pre-existing
  work queue, not an emitter gap).
- Zero regressions across all 5 wasm-posix-kernel gates + the 5 v8
  gates (cctest, d8-smoke, mjsunit, fixture harness, excluding-anchor).
