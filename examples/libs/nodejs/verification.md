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
