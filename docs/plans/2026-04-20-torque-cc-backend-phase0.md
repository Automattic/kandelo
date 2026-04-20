# Phase 0: Torque CC Backend — Verification Gate Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Empirically confirm the assumptions in `2026-04-20-torque-cc-backend-design.md` before committing to implementation: (a) Node.js v24.x's bundled V8 matches the described CCGenerator shape; (b) the 12 unsupported instruction stubs exist as expected; (c) `v8_enable_conservative_stack_scanning` is compatible with `v8_jitless=true`; (d) stock torque builds on host. Also establish `examples/libs/nodejs/` build scaffolding that later phases extend.

**Architecture:** Clone Node.js v24.x into `examples/libs/nodejs/build/node/` (gitignored). A skeleton `build-nodejs.sh` handles clone + host-side torque build only. Verifications are grep assertions against source plus a successful torque binary build that round-trips a stock `.tq` file.

**Tech Stack:**
- Node.js v24.x source (brings V8 13.6.233.17 in `deps/v8/`)
- V8's GN + ninja (host build only; no depot_tools — Node.js vendors its own build scripts)
- Host toolchain: clang/clang++ from Xcode Command Line Tools (macOS) or system gcc (Linux)

**Out of scope for Phase 0:** no Torque compiler patches, no wasm compilation, no actual runtime testing. Pure verification + scaffolding.

---

## Task 0.1: Scaffold `examples/libs/nodejs/` directory

**Files:**
- Create: `examples/libs/nodejs/.gitignore`
- Create: `examples/libs/nodejs/README.md`

**Step 1: Create the directory**

```bash
mkdir -p examples/libs/nodejs
```

**Step 2: Write `.gitignore` to exclude build artifacts**

```gitignore
build/
*.tar.gz
*.tar.xz
```

**Step 3: Write minimal `README.md` pointing to the design doc**

```markdown
# Node.js Port

See `docs/plans/2026-04-15-nodejs-port-design.md` for the overall port plan
and `docs/plans/2026-04-20-torque-cc-backend-design.md` for the Torque
translator that replaces Layer 2.

Build:
```
bash examples/libs/nodejs/build-nodejs.sh
```
```

**Step 4: Commit**

```bash
git add examples/libs/nodejs/.gitignore examples/libs/nodejs/README.md
git commit -m "nodejs: add examples/libs/nodejs/ scaffold"
```

Expected: one commit, two new files, no build artifacts tracked.

---

## Task 0.2: Write `build-nodejs.sh` skeleton — Phase 0 subset

**Files:**
- Create: `examples/libs/nodejs/build-nodejs.sh`

**Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Build Node.js for wasm32-posix.
#
# Phase 0: clones Node.js v24.x and builds the host-side torque binary only.
# Later phases add patches, configure, make, and wasm cross-compile.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${HERE}/build"
NODE_SRC="${BUILD_DIR}/node"
NODE_BRANCH="v24.x"
NODE_REPO="https://github.com/nodejs/node.git"

mkdir -p "${BUILD_DIR}"

if [ ! -d "${NODE_SRC}/.git" ]; then
  echo ">>> Cloning Node.js ${NODE_BRANCH} (shallow)..."
  git clone --depth 1 --branch "${NODE_BRANCH}" "${NODE_REPO}" "${NODE_SRC}"
else
  echo ">>> Node.js source already present at ${NODE_SRC}; skipping clone."
fi

echo ">>> Node.js HEAD: $(cd "${NODE_SRC}" && git rev-parse --short HEAD) on ${NODE_BRANCH}"
echo ">>> V8 version: $(grep -E 'V8_(MAJOR|MINOR|BUILD|PATCH)' "${NODE_SRC}/deps/v8/include/v8-version.h" | awk '{print $3}' | paste -sd. -)"

echo ">>> Phase 0: torque host build only."
cd "${NODE_SRC}"

# Node.js's configure pulls in Python + GN deps. For Phase 0 we only need
# the torque binary. ./configure --help lists --without-* flags we'll use.
# Host-only build does not need cross-compilation plumbing.
if [ ! -f "out/Release/torque" ]; then
  ./configure --ninja
  # torque is a GN subtarget of V8. Ninja can build it alone:
  make torque -j"$(getconf _NPROCESSORS_ONLN)"
else
  echo ">>> torque binary already built at out/Release/torque."
fi

"${NODE_SRC}/out/Release/torque" --help | head -20
echo ">>> Phase 0 OK: torque built and runnable."
```

**Step 2: Make it executable**

```bash
chmod +x examples/libs/nodejs/build-nodejs.sh
```

**Step 3: Commit**

```bash
git add examples/libs/nodejs/build-nodejs.sh
git commit -m "nodejs: add Phase 0 build script — clone + host torque only"
```

Expected: one commit, one executable script.

Note: the `make torque` target may not exist verbatim. Task 0.4 validates and corrects it.

---

## Task 0.3: Run clone step and confirm source layout

**Step 1: Execute the clone portion**

```bash
bash examples/libs/nodejs/build-nodejs.sh 2>&1 | tee /tmp/phase0-clone.log
```

Expected output lines:
- `>>> Cloning Node.js v24.x (shallow)...`
- `>>> Node.js HEAD: <sha> on v24.x`
- `>>> V8 version: 13.6.233.17` (or a patch-level increment if v24.x advanced)

**Step 2: If the V8 version differs at major/minor/build level, STOP and alert**

```bash
V8V=$(grep -E 'V8_(MAJOR|MINOR|BUILD)' examples/libs/nodejs/build/node/deps/v8/include/v8-version.h | awk '{print $3}' | paste -sd. -)
case "$V8V" in
  13.6.233) echo "OK: V8 matches design"; ;;
  *)        echo "STOP: V8 is $V8V, design assumed 13.6.233. Re-verify source references before proceeding."; exit 1 ;;
esac
```

Do NOT proceed past this task if V8 major/minor/build differs. The design references specific line numbers and symbol names verified against 13.6.233; a different version needs re-verification.

Patch level drift (e.g., 13.6.233.18) is fine — patch-level changes in V8 do not affect Torque source shape.

**Step 3: Verify source files exist**

```bash
ls -la examples/libs/nodejs/build/node/deps/v8/src/torque/cc-generator.{h,cc}
ls -la examples/libs/nodejs/build/node/deps/v8/src/torque/csa-generator.{h,cc}
ls -la examples/libs/nodejs/build/node/deps/v8/src/torque/instructions.h
ls -la examples/libs/nodejs/build/node/deps/v8/src/torque/implementation-visitor.{h,cc}
```

Expected: all six files exist and are non-empty.

---

## Task 0.4: Fix `build-nodejs.sh` based on Node.js's actual build interface

**Context:** The draft script in Task 0.2 assumes a `make torque` target exists. Node.js's Makefile may use a different subtarget name (e.g., `v8_torque`, `torque_run`) or may only expose full-build targets.

**Step 1: Inspect Node.js's Makefile for torque-related targets**

```bash
grep -E "(^torque|^v8_torque|torque:)" examples/libs/nodejs/build/node/Makefile | head -20
```

**Step 2: Inspect the GN build for the torque target name**

```bash
grep -rE "executable\(.torque.\)" examples/libs/nodejs/build/node/deps/v8/src/torque/ || \
grep -rE 'name = "torque"' examples/libs/nodejs/build/node/deps/v8/
```

Expected: an executable GN target named `torque` in `deps/v8/src/torque/BUILD.gn`.

**Step 3: Determine the correct ninja invocation**

Node.js's configure produces GN files under `out/Release/`. The target is invokable as:

```bash
cd examples/libs/nodejs/build/node
tools/gn-gen.py out/Release        # or: ./configure --ninja (if not already run)
ninja -C out/Release torque
```

If `ninja -C out/Release torque` fails with "unknown target", try:
- `ninja -C out/Release v8_torque`
- `ninja -C out/Release deps/v8/src/torque/torque`

**Step 4: Edit `build-nodejs.sh` to use the discovered invocation**

Replace the `make torque` line with the working form. Use `Edit` to modify the file.

**Step 5: Re-run and confirm torque binary exists**

```bash
bash examples/libs/nodejs/build-nodejs.sh
test -x examples/libs/nodejs/build/node/out/Release/torque && echo "OK" || echo "FAIL"
```

Expected: `OK`, and `torque --help` prints a usage banner.

**Step 6: Commit the fix**

```bash
git add examples/libs/nodejs/build-nodejs.sh
git commit -m "nodejs: use correct ninja target name for host torque build"
```

---

## Task 0.5: Verify CCGenerator source matches design assumptions

**Context:** The design (Section "Key Finding") claims CCGenerator has a specific shape. Verify it directly in the cloned source rather than relying on memory.

**Step 1: Confirm CCGenerator class inheritance**

```bash
grep -nE "class CCGenerator\s*:\s*public TorqueCodeGenerator" \
  examples/libs/nodejs/build/node/deps/v8/src/torque/cc-generator.h
```

Expected: one match.

**Step 2: Confirm `TorqueCodeGenerator` is the shared base with CSAGenerator**

```bash
grep -nE "class CSAGenerator\s*:\s*public TorqueCodeGenerator" \
  examples/libs/nodejs/build/node/deps/v8/src/torque/csa-generator.h
```

Expected: one match.

**Step 3: Confirm the two instruction-list macros**

```bash
grep -nE "TORQUE_BACKEND_(AGNOSTIC|DEPENDENT)_INSTRUCTION_LIST" \
  examples/libs/nodejs/build/node/deps/v8/src/torque/instructions.h | head -10
```

Expected: at least four matches (definition + usage for each macro).

**Step 4: Count backend-dependent instructions**

```bash
awk '/^#define TORQUE_BACKEND_DEPENDENT_INSTRUCTION_LIST/,/^$/' \
  examples/libs/nodejs/build/node/deps/v8/src/torque/instructions.h | \
  grep -c "V(.*Instruction)"
```

Expected: `22` (matches the design). If different, the design's gap count needs revisiting.

**Step 5: Document findings**

Create `examples/libs/nodejs/verification.md`:

```markdown
# Phase 0 Verification

## V8 source shape

Verified against Node.js v24.x (V8 13.6.233.17):

- `cc-generator.h`: CCGenerator extends TorqueCodeGenerator — confirmed
- `csa-generator.h`: CSAGenerator extends TorqueCodeGenerator — confirmed
- `instructions.h`: TORQUE_BACKEND_DEPENDENT_INSTRUCTION_LIST has N entries — confirmed (N=22 expected)
```

Fill in actual counts and line numbers from the greps above.

**Step 6: Commit**

```bash
git add examples/libs/nodejs/verification.md
git commit -m "nodejs: Phase 0 — verify CCGenerator source shape matches design"
```

---

## Task 0.6: Verify the 12 unsupported instructions are stubs

**Step 1: Extract every `ReportError` line in cc-generator.cc**

```bash
grep -nE 'ReportError\("Not supported in C\+\+ output' \
  examples/libs/nodejs/build/node/deps/v8/src/torque/cc-generator.cc
```

Expected: exactly 12 lines. The design relies on this count.

**Step 2: Record the exact instruction list**

```bash
grep -nE 'void CCGenerator::EmitInstruction\(const \w+Instruction&' \
  examples/libs/nodejs/build/node/deps/v8/src/torque/cc-generator.cc | \
  awk -F'const ' '{print $2}' | awk -F'&' '{print $1}' | sort -u
```

Expected: 22 unique instruction types. Cross-reference with the design's enumeration.

**Step 3: Append findings to `verification.md`**

Append a section listing:
- The 12 stub instructions found (compare against design's list)
- The 10 real-emission instructions found (compare against design's list)

Flag any mismatch — either the design or V8 has drifted.

**Step 4: Commit**

```bash
git add examples/libs/nodejs/verification.md
git commit -m "nodejs: Phase 0 — verify 12 stub instructions match design"
```

---

## Task 0.7: Verify the fourth-pass extension seam

**Step 1: Confirm `output_type_` dispatch region**

```bash
grep -nE "output_type_ = OutputType::(kCC|kCCDebug|kCSA)" \
  examples/libs/nodejs/build/node/deps/v8/src/torque/implementation-visitor.cc
```

Expected: at least three matches (kCC, kCCDebug, kCSA assignments around line 3540–3575 of the design).

**Step 2: Confirm `ShouldGenerateExternalCode` virtual**

```bash
grep -nE "ShouldGenerateExternalCode" \
  examples/libs/nodejs/build/node/deps/v8/src/torque/declarable.h \
  examples/libs/nodejs/build/node/deps/v8/src/torque/declarable.cc
```

Expected: one or more matches. This is the per-declarable filter we override.

**Step 3: Confirm OutputType enum definition**

```bash
grep -rnE "enum class OutputType" \
  examples/libs/nodejs/build/node/deps/v8/src/torque/
```

Expected: one match (likely in `utils.h` or a shared header).

**Step 4: Append findings to `verification.md`**

Record:
- File + line where the three existing passes live
- File + line of OutputType enum (for adding `kCCBuiltins`)
- File + line of ShouldGenerateExternalCode (for override)

**Step 5: Commit**

```bash
git add examples/libs/nodejs/verification.md
git commit -m "nodejs: Phase 0 — verify pass-dispatch extension seam"
```

---

## Task 0.8: Verify `v8_enable_conservative_stack_scanning` + `v8_jitless` compatibility

**Context:** Design Section 3 ("GC via CSS") stakes the whole translator complexity reduction on CSS being usable in jitless mode. This is the single most important verification in Phase 0.

**Step 1: Confirm the GN flag exists**

```bash
grep -rnE "v8_enable_conservative_stack_scanning" \
  examples/libs/nodejs/build/node/deps/v8/BUILD.gn \
  examples/libs/nodejs/build/node/deps/v8/gni/ \
  examples/libs/nodejs/build/node/deps/v8/tools/
```

Expected: declaration in a `.gn` or `.gni` file + at least one consuming reference.

**Step 2: Look for explicit incompatibility guards**

```bash
grep -rnE "jitless.*conservative_stack|conservative_stack.*jitless" \
  examples/libs/nodejs/build/node/deps/v8/
```

Expected: **no matches**. If any match shows an `assert(!(jitless && css))`-style guard, the design must fall back to Option B (explicit Handle discipline).

**Step 3: Look for defines the flag sets**

```bash
grep -rnE "V8_ENABLE_CONSERVATIVE_STACK_SCANNING" \
  examples/libs/nodejs/build/node/deps/v8/src/ | head -30
```

Expected: the flag gates real code paths in `src/heap/` and the GC. Confirms it's a live feature, not a stub.

**Step 4: Do a trial build with CSS + jitless (the definitive test)**

Edit `examples/libs/nodejs/build-nodejs.sh` to pass these configure args when building torque-only is insufficient. Since we want the binary to witness the flag combination compiling, do a full host V8 build (not just torque):

```bash
cd examples/libs/nodejs/build/node
./configure --ninja --v8-options='v8_enable_conservative_stack_scanning=true v8_jitless=true v8_enable_turbofan=false'
ninja -C out/Release v8_snapshot 2>&1 | tee /tmp/phase0-cssbuild.log
```

Expected: `v8_snapshot` target builds successfully. If it fails with an assertion/error referencing CSS+jitless incompatibility, fall back to Option B in the design.

Note: `--v8-options` syntax varies by Node.js version. Consult `./configure --help | grep v8` for the exact flag. If Node.js's configure doesn't pass-through GN flags, edit `deps/v8/BUILD.gn` directly to default the flags to true for this verification build, then revert.

**Step 5: Record the outcome**

Append to `verification.md`:
- Whether CSS is enabled by default or opt-in in V8 13.6.233
- Whether the CSS + jitless build completed
- If it failed, the exact error — this determines whether design pivots to Option B

**Step 6: Commit**

```bash
git add examples/libs/nodejs/verification.md
git commit -m "nodejs: Phase 0 — verify CSS + jitless compatibility"
```

**Gate:** if the build failed and the design must pivot to Option B (Handle discipline), STOP and update `docs/plans/2026-04-20-torque-cc-backend-design.md` before Phase 1. Do not proceed with Phase 1 on a broken assumption.

---

## Task 0.9: Smoke-test torque on a stock `.tq` file

**Context:** Before we patch torque, confirm the stock binary produces output we recognize.

**Step 1: Pick a small `.tq` input**

```bash
ls examples/libs/nodejs/build/node/deps/v8/src/builtins/*.tq | head -5
```

Use a small one — `typed-array-of.tq` or `array-isarray.tq` are usually <100 lines.

**Step 2: Run torque on it**

```bash
cd examples/libs/nodejs/build/node
mkdir -p /tmp/torque-out
./out/Release/torque \
  -o /tmp/torque-out \
  -v8-root deps/v8 \
  deps/v8/src/builtins/array-isarray.tq
```

Arguments depend on the torque CLI. Consult `torque --help` (from Task 0.4) for exact flag names.

**Step 3: Verify the expected output files**

```bash
find /tmp/torque-out -type f | sort
```

Expected: files ending in `-tq-csa.cc`, `-tq-csa.h`, `-tq.cc`, `-tq-debug.cc`, `-tq.inc`.

**Step 4: Open `-tq.cc` and confirm CCGenerator output**

```bash
head -50 /tmp/torque-out/src/builtins/array-isarray-tq.cc
```

Expected: portable C++ with `Tagged<Object>` locals, no `TNode<>`, no CodeStubAssembler references. This is what our extended CCGenerator will produce at scale.

**Step 5: Append findings to `verification.md`**

Record torque CLI, output file naming, and a sample of the generated C++ so Phase 1 has a concrete reference for what "working output" looks like.

**Step 6: Commit**

```bash
git add examples/libs/nodejs/verification.md
git commit -m "nodejs: Phase 0 — smoke-test torque on stock .tq, capture output shape"
```

---

## Task 0.10: Write Phase 0 completion summary

**Step 1: Append to `verification.md`**

```markdown
## Phase 0 Summary

| Item | Result |
|---|---|
| Node.js v24.x cloned | ✅ / ❌ |
| V8 version matches design (13.6.233.x) | ✅ / ❌ |
| Torque binary builds on host | ✅ / ❌ |
| CCGenerator shape matches design | ✅ / ❌ |
| 12 stub instructions confirmed | ✅ / ❌ |
| Fourth-pass seam confirmed | ✅ / ❌ |
| CSS + jitless compatible | ✅ / ❌ |
| Torque round-trips a .tq on host | ✅ / ❌ |

**Decision:** proceed to Phase 1 / pivot to Option B / revise design (pick one).
```

Fill in based on actual results.

**Step 2: Commit**

```bash
git add examples/libs/nodejs/verification.md
git commit -m "nodejs: Phase 0 complete — verification summary"
```

**Step 3: Open PR**

Per the project's workflow (never merge to main without PR):

```bash
git push -u origin torque-cc-backend
gh pr create --title "torque-cc-backend: Phase 0 verification" --body "$(cat <<'EOF'
## Summary
- Adds `examples/libs/nodejs/` scaffolding
- Adds Phase 0 build script (clone + host torque build only)
- Verifies design assumptions against real Node.js v24.x source (V8 13.6.233.17)

See `docs/plans/2026-04-20-torque-cc-backend-design.md` for context.
See `examples/libs/nodejs/verification.md` for results.

## Test plan
- [ ] `bash examples/libs/nodejs/build-nodejs.sh` completes
- [ ] torque binary exists at `build/node/out/Release/torque`
- [ ] `verification.md` Phase 0 Summary shows all items ✅

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Done Criteria

Phase 0 is complete when:

1. All 10 tasks committed on branch `torque-cc-backend`.
2. `examples/libs/nodejs/verification.md` summary table shows no ❌ entries (or: clearly-identified ❌ that triggers a design pivot, documented in a new commit).
3. PR opened against `main`.

**Next:** if Phase 0 is green, write `2026-04-20-torque-cc-backend-phase1.md` covering scaffolding (new OutputType pass + ShouldGenerateExternalCode override + ReportError stubs). If Phase 0 revealed CSS is unusable, first update the design doc with Option B before writing Phase 1.
