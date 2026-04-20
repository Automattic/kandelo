# Phase 0 Verification

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

## Torque host build (Tasks 0.2–0.4)

- Node.js uses gyp+ninja (not `make torque` as the skeleton assumed).
- Correct invocation: `ninja -C out/Release torque` after `./configure --ninja`.
- Resulting binary: `examples/libs/nodejs/build/node/out/Release/torque`
  (Mach-O 64-bit arm64 on host macOS).
- `torque --help` does not exist — torque aborts on any unknown arg. The
  build script now just verifies the binary is executable.
