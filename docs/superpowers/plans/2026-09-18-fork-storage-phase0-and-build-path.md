# Fork Storage: Phase 0 Guards and the Build Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair three guards that do not guard, then converge nine
hand-maintained copies of the SDK link contract onto the SDK itself, so the
fork-module storage work that follows is sized against the real memory layout.

**Architecture:** Phase 0 fixes tests that either fail at HEAD or assert
nothing, because the storage work will be validated by this suite and a suite
with dead guards cannot validate it. The build path then routes every program
through `sdk/src/lib/flags.ts`, restoring `__heap_base` (currently missing
everywhere, forcing a 16 MiB brk fallback) and the 8 MiB shadow stack.

**Tech Stack:** Rust (`no_std` PIC wasm side module), TypeScript (host +
Vitest), bash build scripts, wasm-ld via clang.

**Spec:** `docs/superpowers/specs/2026-09-18-fork-dynamic-storage-design.md`

## Global Constraints

- ABI is **44** and unreleased; this project defines its contents. Changing it
  requires regenerating `abi/snapshot.json` in the same commit.
- Run `npx vitest run host/test/surface-budget.test.ts` before **every**
  commit and gate on its exit status, not on grep output. **Never raise a
  ceiling to make a check pass.**
- **Perturb every new or changed guard until it fails**, then restore from a
  pristine copy — never `git checkout --`, which silently discards uncommitted
  work and leaves built artifacts stale.
- Commit message body and subject wrap at **72 columns**; subject begins
  `Area: Purpose`. Gate on a checker's exit status (`awk` exits 0 even when it
  prints violations).
- After changing `crates/fork-module/src/**`, rebuild
  (`bash crates/fork-module/build-wasm.sh`) and confirm
  `--verify-fresh` exits 0. Confirm the build key CHANGED after a
  perturbation; an unchanged key means the perturbation never reached the
  artifact.
- Work only in the lane worktree on branch
  `brandonpayton/lane-f-fork-inversion`. Push after every commit.
- Host `src/` edits are invisible to centralized tests until
  `cd host && npm run build`, because those tests load
  `host/dist/node-kernel-worker-entry.js`.

---

## File Structure

| File | Responsibility | Phase |
|---|---|---|
| `host/test/fork-module-instance.test.ts` | asserts the module region covers static+stack+staging, by derivation not constant | 0 |
| `host/src/fork-module-instance.ts` | exports `forkModuleRegionParts()` so the test can derive | 0 |
| `crates/fork-module/src/lib.rs` | exposes identity chunk count through `fm_stats`; corrects a false comment | 0 |
| `host/test/fork-identity-release.test.ts` | NEW: asserts chunk count returns to zero after dlclose | 0 |
| `scripts/build-programs.sh` | routes compilation through the SDK; `LINK_POST_LIBS` deleted | 1 |
| `sdk/src/lib/flags.ts` | honours an explicit smaller stack with a warning | 1 |
| `programs/p_11_fork_continuation_enomem.c` | unchanged; gains a second fixture entry | 1 |
| `host/test/fork-instrument-coverage.test.ts` | two P-11 fixtures: tight and adaptive | 1 |
| `host/src/process-lifecycle.ts` | fails loud when a program admits without `__heap_base` | 1 |

---

## Phase 0 — Repair the guards that do not guard

### Task 1: Make the module-region test survive a shrinking module

`host/test/fork-module-instance.test.ts:50` asserts
`reserved.size > 4 * 1024 * 1024`. That is a FLOOR ON MEMORY USE: it fails when
the module gets smaller, which is the goal of the work that follows. It already
failed during the spec experiment with
`expected 3735552 to be greater than 4194304`.

**Files:**
- Modify: `host/src/fork-module-instance.ts` (export a derivation helper)
- Modify: `host/test/fork-module-instance.test.ts:46-53`

**Interfaces:**
- Produces: `forkModuleRegionParts(module: WebAssembly.Module, label: string):
  { staticBytes: number; shadowStackBytes: number; stagingBytes: number;
  regionBytes: number }` — exported from `host/src/fork-module-instance.ts`,
  used by Task 1's test and available to later phases.

- [ ] **Step 1: Export the derivation from the instance module**

In `host/src/fork-module-instance.ts`, directly after the existing
`readDylinkMemInfo` function, add:

```ts
/**
 * The three terms of the reserved region, derived from the module itself.
 *
 * Exported so tests can assert the RELATIONSHIP (the region covers static
 * plus shadow stack plus staging) instead of a constant. A constant here is a
 * floor on memory use: it fails when the module shrinks, which is the point of
 * the storage work this supports.
 */
export function forkModuleRegionParts(
  module: WebAssembly.Module,
  label: string,
): {
  staticBytes: number;
  shadowStackBytes: number;
  stagingBytes: number;
  regionBytes: number;
} {
  const info = readDylinkMemInfo(module, label);
  const staticBytes = alignUp(info.memorySize, info.memoryAlign);
  const stackTopOffset = staticBytes + SHADOW_STACK_BYTES;
  const stagingOffset = alignUp(stackTopOffset, WASM_PAGE_BYTES);
  return {
    staticBytes,
    shadowStackBytes: SHADOW_STACK_BYTES,
    stagingBytes: STAGING_SLAB_BYTES,
    regionBytes: stagingOffset + STAGING_SLAB_BYTES,
  };
}
```

- [ ] **Step 2: Replace the constant assertion with the derived one**

In `host/test/fork-module-instance.test.ts`, add `forkModuleRegionParts` to the
existing import from `../src/fork-module-instance`, then replace:

```ts
    // The reserved region covers the module's ~4 MiB static footprint plus the
    // shadow stack, and fits inside the provided memory.
    expect(reserved!.size).toBeGreaterThan(4 * 1024 * 1024);
```

with:

```ts
    // WHAT THIS ASSERTS, and why not a constant: the region must cover the
    // module's OWN declared static footprint plus its shadow stack and staging
    // slab. The previous `> 4 MiB` was a floor on memory USE -- it failed when
    // the module shrank, which is the goal of the storage work, and it did
    // fail during the spec experiment at 3,735,552 bytes.
    const parts = forkModuleRegionParts(moduleForTest, "test");
    expect(reserved!.size).toBe(parts.regionBytes);
    expect(parts.regionBytes).toBeGreaterThanOrEqual(
      parts.staticBytes + parts.shadowStackBytes + parts.stagingBytes,
    );
```

If the test does not already hold the compiled module in a variable named
`moduleForTest`, use whatever variable it passes to `instantiateForkModule` as
`module`.

- [ ] **Step 3: Run the test**

```bash
cd /Users/brandon/kandelo-lane-f
npx vitest run host/test/fork-module-instance.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 4: Perturb — prove the new assertion can fail**

Temporarily change `expect(reserved!.size).toBe(parts.regionBytes);` to
`expect(reserved!.size).toBe(parts.regionBytes + 1);` and re-run.

Expected: FAIL. Then restore the line by hand (do NOT `git checkout --`).

- [ ] **Step 5: Budget, then commit**

```bash
npx vitest run host/test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"   # must be 0; read the Tests line in /tmp/b.txt
git add host/src/fork-module-instance.ts host/test/fork-module-instance.test.ts
git commit -m "Fork: Assert the module region by derivation, not a constant"
git push origin brandonpayton/lane-f-fork-inversion
```

---

### Task 2: Sweep for sibling guards that assert a constant

Task 1's guard was invisible until something shrank. Others may be waiting.

**Files:**
- Read only: `host/test/**/*.test.ts`

- [ ] **Step 1: List every numeric comparison against a size-like constant**

```bash
cd /Users/brandon/kandelo-lane-f
grep -rnE "toBeGreaterThan(OrEqual)?\(\s*[0-9_]+\s*\*|toBeGreaterThan(OrEqual)?\(\s*[0-9]{5,}" \
  host/test/*.test.ts | tee /tmp/size-guards.txt
wc -l /tmp/size-guards.txt
```

- [ ] **Step 2: Classify each hit**

For each line, decide: does it assert a MINIMUM size (a floor on memory use,
which this work will break), or a maximum/capacity (legitimate)? Record the
classification inline in a scratch file. A minimum-size assertion on anything
the storage work shrinks must be converted the way Task 1 converted its own.

- [ ] **Step 3: Commit the findings as a doc note**

Append the classified list to
`docs/plans/2026-09-16-lane-f-closure.md` under a heading
`## Guards that assert a minimum size (swept 2026-09-18)`, then:

```bash
npx vitest run host/test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
git add docs/plans/2026-09-16-lane-f-closure.md
git commit -m "Docs: Sweep for guards that assert a minimum module size"
git push origin brandonpayton/lane-f-fork-inversion
```

---

### Task 3: Make the identity release path observable, and prove it runs

`identity_chunk_count()` (`crates/fork-module/src/lib.rs:1167`) has exactly one
reference in the repository — its own definition. The compiler reports
`warning: function identity_chunk_count is never used`. Its doc comment claims
`fork-identity-capacity.test.ts` asserts it returns to zero after a release;
that test reads module source with a regex and never calls into the module.

So the release path this whole design cites as precedent has never been
demonstrated to run.

**Files:**
- Modify: `crates/fork-module/src/lib.rs` (`fm_stats` field + comment fix)
- Create: `host/test/fork-identity-release.test.ts`

**Interfaces:**
- Consumes: `fm_stats(field: u32) -> i64`, already exported.
- Produces: a new `fm_stats` field returning the live identity chunk count.

- [ ] **Step 1: Find the next free `fm_stats` field number**

```bash
cd /Users/brandon/kandelo-lane-f
sed -n "$(grep -n 'pub extern "C" fn fm_stats' crates/fork-module/src/lib.rs \
  | head -1 | cut -d: -f1),+40p" crates/fork-module/src/lib.rs
```

Read the `match field { ... }` arms and note the highest number in use. Call
the next one `N` below.

- [ ] **Step 2: Write the failing test**

Create `host/test/fork-identity-release.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CHANNEL_RESPONDER, MUNMAP_COUNTER, PAGE } from "./fork-module-capture-fixture";

// WHY THIS EXISTS: `identity_chunk_count()` was written as the observable for
// the identity release path, documented as asserted by
// `fork-identity-capacity.test.ts`, and never exported or called -- the
// compiler reported it as dead code. A chunk list can leak where a fixed array
// could not, so the release path needs an observable that something reads.
describe("identity chunk release", () => {
  it("returns every chunk an activation filled when it is released", async () => {
    const x = await instantiateFixtureModule();   // see Step 3
    const chunks = (): number => Number(x.fm_stats(IDENTITY_CHUNK_COUNT_FIELD));

    expect(chunks(), "nothing mapped before any publish").toBe(0);

    for (let i = 0; i < 4_100; i++) {
      x.fm_set_identity_group(0, 7, i + 1, i + 1);
    }
    expect(chunks(), "4,100 identities span more than one chunk")
      .toBeGreaterThan(1);

    x.fm_resume_slots(1, 7, 0);   // op 1 = the dlclose entry point
    expect(chunks(), "release returns every chunk").toBe(0);
  });
});
```

Set `IDENTITY_CHUNK_COUNT_FIELD` to the `N` from Step 1. For
`instantiateFixtureModule`, copy the instantiation helper used by
`host/test/fork-module-imported-globals-seed.test.ts` — it already services the
channel via `CHANNEL_RESPONDER`, which this test needs because publishing
identities calls `channel_mmap`.

- [ ] **Step 3: Run it and watch it fail**

```bash
npx vitest run host/test/fork-identity-release.test.ts
```

Expected: FAIL — `fm_stats` returns -1 for an unknown field, so `chunks()` is
-1 rather than 0.

- [ ] **Step 4: Add the `fm_stats` field**

In `crates/fork-module/src/lib.rs`, inside `fm_stats`'s `match field`, add an
arm for `N`:

```rust
            // The identity chunk list's live length. A fixed array could not
            // leak; a chunk list can, so the release path needs an observable
            // something actually reads -- this one was dead code for its whole
            // existence, with a comment claiming a test asserted it.
            N => return identity_chunk_count() as i64,
```

Replace `N` with the number chosen in Step 1, matching the surrounding arms'
style (if they read counters through a helper, follow that shape instead).

- [ ] **Step 5: Correct the false comment**

In `crates/fork-module/src/lib.rs`, in the doc comment above
`fn identity_chunk_count`, replace:

```
    /// A fixed array could not leak; a chunk list can, so the release path needs
    /// an observable. This is what `fork-identity-capacity.test.ts` asserts
    /// returns to zero after an activation is released.
```

with:

```
    /// A fixed array could not leak; a chunk list can, so the release path
    /// needs an observable. Exposed through `fm_stats` and asserted by
    /// `host/test/fork-identity-release.test.ts`, which publishes enough
    /// identities to span several chunks and requires the count back at zero
    /// after `fm_resume_slots` op 1.
    ///
    /// It previously named `fork-identity-capacity.test.ts`, which asserts
    /// nothing of the kind -- that file reads this source with a regex and
    /// never calls the module. The function was dead code for its whole
    /// existence and the compiler said so.
```

- [ ] **Step 6: Rebuild and re-run**

```bash
bash crates/fork-module/build-wasm.sh
bash crates/fork-module/build-wasm.sh --verify-fresh; echo "FRESH: $?"   # 0
npx vitest run host/test/fork-identity-release.test.ts
```

Expected: PASS.

- [ ] **Step 7: Perturb — prove the guard can fail**

Copy the source aside first:

```bash
cp crates/fork-module/src/lib.rs /tmp/lib.pristine
```

Comment out the `channel_munmap` call in `release_identity_activation`
(`crates/fork-module/src/lib.rs`, the line
`let _ = channel_munmap(base, chunk, IDENTITY_CHUNK_BYTES);`), rebuild, and
re-run the test.

Expected: FAIL — chunks are unlinked but never returned, so the count does not
reach zero. Confirm the build key CHANGED between builds; an unchanged key
means the perturbation never reached the artifact.

Restore with `cp /tmp/lib.pristine crates/fork-module/src/lib.rs`, rebuild, and
confirm `--verify-fresh` is 0 again.

- [ ] **Step 8: Budget, then commit**

```bash
npx vitest run host/test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
git add crates/fork-module/src/lib.rs host/test/fork-identity-release.test.ts
git commit -m "Fork: Make the identity release path observable and assert it"
git push origin brandonpayton/lane-f-fork-inversion
```

---

### Task 4: Establish what is red before adding to it

A guard in this lane was red at HEAD for days because the surface budget counts
lines and cannot see a broken assertion in a file nobody runs.

**Files:**
- Create: `docs/plans/2026-09-18-fork-suite-baseline.md`

- [ ] **Step 1: Build the host bundle first**

Centralized tests load `host/dist/node-kernel-worker-entry.js`, so a stale
bundle makes every result meaningless.

```bash
cd /Users/brandon/kandelo-lane-f/host && npm run build && cd ..
```

- [ ] **Step 2: Run the whole fork surface and capture it**

```bash
npx vitest run host/test/fork-*.test.ts > /tmp/fork-baseline.txt 2>&1
echo "SUITE_EXIT: $?"
grep -E "Test Files |Tests |FAIL" /tmp/fork-baseline.txt
```

- [ ] **Step 3: Record the baseline**

Write `docs/plans/2026-09-18-fork-suite-baseline.md` containing the date, the
exact command, the `Test Files`/`Tests` summary lines, and every `FAIL` line
verbatim. For each failure state whether it predates this lane (check with
`git log -S` on the symbol in the error) or was introduced by it.

- [ ] **Step 4: Commit**

```bash
npx vitest run host/test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
git add docs/plans/2026-09-18-fork-suite-baseline.md
git commit -m "Docs: Record the fork suite baseline before the build change"
git push origin brandonpayton/lane-f-fork-inversion
```

---

## Phase 1 — The build path

### Task 5: Isolate this worktree's build cache

`run.sh:24-32`: `KANDELO_SOURCE_CACHE_ROOT` unset shares
`$HOME/.cache/kandelo/source-only` across worktrees, and the documentation says
to set it "to isolate a worktree whose in-progress change alters cached
artifact bytes". Relinking every program is exactly that, and
`git worktree list` reports 222 worktrees on this machine.

**Files:**
- Create: `.envrc.lane-f` (a file the operator sources; NOT auto-loaded)

- [ ] **Step 1: Create the isolation file**

```bash
cd /Users/brandon/kandelo-lane-f
cat > .envrc.lane-f <<'EOF'
# Isolate this worktree's SourceOnly build cache for the duration of the
# link-contract convergence. Without this, relinking every program writes
# artifact bytes into a cache shared by every worktree on this machine
# (222 at last count). See run.sh:24-32.
export KANDELO_SOURCE_CACHE_ROOT="/Users/brandon/kandelo-lane-f/.cache/source-only"
EOF
mkdir -p .cache/source-only
```

- [ ] **Step 2: Confirm it is ignored by git**

```bash
git check-ignore -v .cache/source-only || echo "NOT IGNORED — add it"
```

If not ignored, add `/.cache/` to `.gitignore` in this commit.

- [ ] **Step 3: Commit**

```bash
npx vitest run host/test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
git add .envrc.lane-f .gitignore
git commit -m "Build: Isolate this worktree's source cache before relinking"
git push origin brandonpayton/lane-f-fork-inversion
```

**Every later task in this phase must be run with `.envrc.lane-f` sourced.**

---

### Task 6: Measure the P-11 recursion's stack headroom

`programs/p_11_fork_continuation_enomem.c` calls `fork_at_depth(4096)` on what
is currently wasm-ld's 64 KiB default shadow stack, because
`build-programs.sh` never passes `-z,stack-size`. WebAssembly has no guard
page: an overflow writes past `__data_end` into `.bss` rather than trapping.

It passes today, so either the frames are small or something else is true.
Task 7 changes that stack to 8 MiB, so the margin must be known BEFORE it
moves.

**Files:**
- Modify: `docs/plans/2026-09-18-fork-suite-baseline.md` (append findings)

- [ ] **Step 1: Disassemble the recursive function**

```bash
cd /Users/brandon/kandelo-lane-f
LLVM_BIN="$(ls -d "$(dirname "$(command -v clang)")" 2>/dev/null)"
"$LLVM_BIN/llvm-objdump" -d \
  local-binaries/programs/wasm32/p_11_fork_continuation_enomem.wasm \
  > /tmp/p11.dis 2>&1 || \
  wasm-objdump -d local-binaries/programs/wasm32/p_11_fork_continuation_enomem.wasm \
  > /tmp/p11.dis
grep -n "fork_at_depth" /tmp/p11.dis | head
```

- [ ] **Step 2: Read the frame size**

In the disassembly of `fork_at_depth`, find the prologue's adjustment of
`__stack_pointer` — a `global.get 0`, an `i32.const N`, an `i32.sub`, and a
`global.set 0`. `N` is the per-frame shadow-stack cost. Record it.

- [ ] **Step 3: Compute the margin and record it**

```bash
python3 -c "
N = FRAME_BYTES   # from Step 2
print('4096 frames need', 4096*N, 'bytes =', round(4096*N/1024), 'KiB')
print('against a 64 KiB default stack:', 'OVERFLOWS' if 4096*N > 65536 else 'fits')
"
```

Append to `docs/plans/2026-09-18-fork-suite-baseline.md` under
`## P-11 recursion headroom`: the frame size, the total, and whether it
overflows. **If it overflows, stop and report** — P-11 is currently corrupting
`.bss` and that is a live defect to fix before anything else moves.

- [ ] **Step 4: Commit**

```bash
npx vitest run host/test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
git add docs/plans/2026-09-18-fork-suite-baseline.md
git commit -m "Docs: Measure P-11's shadow-stack headroom before it moves"
git push origin brandonpayton/lane-f-fork-inversion
```

---

### Task 7: Let the SDK honour an explicit smaller stack, with a warning

`mainThreadStackSize` (`sdk/src/lib/flags.ts:218-231`) returns
`max(8 MiB, requested)`, so an explicit smaller request is silently discarded —
the SDK builds something other than what was asked for and does not say so.

Two situations are currently conflated and must not be: ABSENCE of a request is
a default (apply 8 MiB silently); an explicit smaller request is a choice
(honour it, warn).

**Files:**
- Modify: `sdk/src/lib/flags.ts:218-231`
- Test: `sdk/test/flags.test.ts`

**Interfaces:**
- Produces: `mainThreadStackSize` returns the caller's explicit value even
  below `DEFAULT_MAIN_THREAD_STACK_SIZE`, emitting one warning line to stderr.

- [ ] **Step 1: Write the failing test**

Append to `sdk/test/flags.test.ts`:

```ts
it("honours an explicit stack smaller than the floor, and warns", () => {
  const warnings: string[] = [];
  const restore = console.warn;
  console.warn = (msg: string) => warnings.push(String(msg));
  try {
    const size = mainThreadStackSize(["-z", "stack-size=65536"]);
    expect(size, "the caller's explicit request wins").toBe(65536);
    expect(warnings.join("\n")).toMatch(/stack-size=65536/);
    expect(warnings.join("\n")).toMatch(/\.bss|guard page|corrupt/i);
  } finally {
    console.warn = restore;
  }
});

it("still applies the floor when no stack size is requested", () => {
  expect(mainThreadStackSize([])).toBe(DEFAULT_MAIN_THREAD_STACK_SIZE);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/brandon/kandelo-lane-f
npx vitest run sdk/test/flags.test.ts
```

Expected: FAIL — the first test gets 8388608, not 65536.

- [ ] **Step 3: Change the resolution**

In `sdk/src/lib/flags.ts`, replace the `consider` closure's final line:

```ts
    if (requested.kind === 'valid' && requested.value > result) result = requested.value;
```

with:

```ts
    if (requested.kind !== 'valid') return;
    if (requested.value < DEFAULT_MAIN_THREAD_STACK_SIZE) {
      // HONOUR IT, LOUDLY. Silently substituting the floor meant the SDK built
      // something other than what was asked for and did not say so. Absence of
      // a request still gets the floor (see the initial value of `result`):
      // that is a default. An explicit smaller request is a CHOICE, and the
      // only situation that warrants one is a fixture deliberately exercising
      // a constrained layout.
      //
      // The warning is informational, not the safety mechanism. WebAssembly
      // has no stack guard page, so an overflow writes past `__data_end` into
      // `.bss` and corrupts the pthread/TLS globals there rather than
      // trapping. The DEFAULT is the protection.
      console.warn(
        `wasm32posix: stack-size=${requested.value} is below the SDK floor of ` +
          `${DEFAULT_MAIN_THREAD_STACK_SIZE}. Honouring it. WebAssembly has no ` +
          `stack guard page: an overflow will corrupt .bss silently instead of ` +
          `trapping.`,
      );
    }
    result = requested.value;
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run sdk/test/flags.test.ts
```

Expected: PASS, including the pre-existing cases in that file.

- [ ] **Step 5: Perturb**

Temporarily change `result = requested.value;` back to
`if (requested.value > result) result = requested.value;` and re-run.

Expected: the new "honours an explicit stack" test FAILS. Restore by hand.

- [ ] **Step 6: Budget, then commit**

```bash
npx vitest run host/test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
git add sdk/src/lib/flags.ts sdk/test/flags.test.ts
git commit -m "SDK: Honour an explicit smaller stack instead of discarding it"
git push origin brandonpayton/lane-f-fork-inversion
```

---

### Task 8: Route `build-programs.sh` through the SDK

`scripts/build-programs.sh:128` invokes `clang` directly with a hand-maintained
`LINK_POST_LIBS` array — a second copy of the SDK's link contract that has
drifted from `sdk/src/lib/flags.ts:259-298`, missing `--export=__heap_base`,
`-z,stack-size=8388608` and `--global-base=1114112`.

**Files:**
- Modify: `scripts/build-programs.sh:126-177`

- [ ] **Step 1: Confirm the SDK wrapper works standalone**

```bash
cd /Users/brandon/kandelo-lane-f
echo 'int main(void){return 0;}' > /tmp/t.c
./sdk/bin/wasm32posix-cc /tmp/t.c -o /tmp/t.wasm && echo "SDK CC OK"
node -e '
const {readFileSync}=require("fs");
(async()=>{const m=await WebAssembly.compile(readFileSync("/tmp/t.wasm"));
const e=WebAssembly.Module.exports(m).map(x=>x.name);
console.log("__heap_base exported:", e.includes("__heap_base"));})();'
```

Expected: `SDK CC OK` and `__heap_base exported: true`. **If the wrapper cannot
run here, stop and report** — `CLAUDE.md` requires build scripts to use the
worktree-local SDK, and a second copy of the flags is what this task removes.

- [ ] **Step 2: Replace the compiler and drop the duplicated flags**

In `scripts/build-programs.sh`, change:

```bash
CC="$LLVM_BIN/clang"
```

to:

```bash
# The SDK owns the link contract. This script used to carry its own copy in
# LINK_POST_LIBS, which drifted and lost --export=__heap_base,
# -z,stack-size and --global-base -- so every test program ran on a 16 MiB
# brk fallback and a 64 KiB shadow stack. CLAUDE.md requires build scripts to
# use the worktree-local SDK; one copy of a rule cannot disagree with itself.
CC="$REPO_ROOT/sdk/bin/wasm32posix-cc"
```

Then delete every `-Wl,` entry from the `LINK_POST_LIBS` array, keeping only
`"$SYSROOT/lib/libc.a"` and any per-program archives spliced before it. Also
delete from `CFLAGS` any flag the SDK already supplies (`--target`,
`--sysroot`, `-nostdlib`); keep the ones it does not
(`-O2`, `-matomics`, `-mbulk-memory`, `-fno-trapping-math`, the `-mllvm`
pair) unless the SDK errors on them.

- [ ] **Step 3: Rebuild the programs**

```bash
source .envrc.lane-f
bash scripts/build-programs.sh 2>&1 | tail -20
echo "BUILD_EXIT: $?"
```

- [ ] **Step 4: Verify the flags actually arrived**

```bash
node -e '
const {readFileSync}=require("fs");
(async()=>{
 for (const p of ["p_11_fork_continuation_enomem","sh","p_01_fork_main_thread"]) {
  const m=await WebAssembly.compile(
    readFileSync(`local-binaries/programs/wasm32/${p}.wasm`));
  const e=WebAssembly.Module.exports(m).map(x=>x.name);
  console.log(p.padEnd(34), "__heap_base:", e.includes("__heap_base"));
 }})();'
```

Expected: `true` for all three. This is the defect this whole phase exists to
fix; if any is `false`, the flags did not arrive and Step 2 is incomplete.

- [ ] **Step 5: Run the fork suite against the relinked programs**

```bash
cd host && npm run build && cd ..
npx vitest run host/test/fork-*.test.ts > /tmp/fork-after.txt 2>&1
echo "SUITE_EXIT: $?"
grep -E "Test Files |Tests |FAIL" /tmp/fork-after.txt
diff <(grep FAIL /tmp/fork-baseline.txt) <(grep FAIL /tmp/fork-after.txt)
```

Compare against the Task 4 baseline. **Any NEW failure is caused by this
change** — most likely P-11, whose address-space arithmetic moves when the brk
base drops from 16 MiB to the real `__heap_base`. Task 9 handles P-11; any
other new failure must be understood before proceeding.

- [ ] **Step 6: Budget, then commit**

```bash
npx vitest run host/test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
git add scripts/build-programs.sh
git commit -m "Build: Route test programs through the SDK, deleting a flag copy"
git push origin brandonpayton/lane-f-fork-inversion
```

---

### Task 9: Split P-11 into a tight fixture and an adaptive one

P-11's tightness comes from a DEFECT: the missing `__heap_base` forced a 16 MiB
brk fallback out of a 24 MiB process. Task 8 removes that defect, so the
fixture must state its constraint deliberately or silently stop testing what it
claims.

**Files:**
- Modify: `host/test/fork-instrument-coverage.test.ts:460-480`

- [ ] **Step 1: Find the new address-space numbers**

Run P-11 under the relinked binary and read what layout it now gets:

```bash
npx vitest run host/test/fork-instrument-coverage.test.ts \
  -t "p_11" 2>&1 | tail -40
```

Record whether it still reaches `ENOMEM`. If it passes unchanged, its
constraint is no longer doing anything and the tight fixture must lower
`maxPages` until exhaustion is reachable again.

- [ ] **Step 2: Make the tight fixture's constraint explicit**

In `host/test/fork-instrument-coverage.test.ts`, at the `runFixture` call for
`programs/p_11_fork_continuation_enomem.wasm`, replace `maxPages: 384` with the
value found in Step 1 and add above it:

```ts
      // TIGHT FIXTURE. The address space is constrained DELIBERATELY so the
      // error paths are reachable: root-allocation ENOMEM with no child, no
      // phantom child, a mid-unwind ABORT_UNWINDING, full unmapping, and a
      // recovery fork. Before 2026-09-18 this tightness came from a DEFECT --
      // the missing __heap_base export forced a 16 MiB brk fallback out of a
      // 24 MiB process -- so fixing the export would have made this fixture
      // quietly stop exercising what it claims. Constrained by maxPages, not
      // by stack size: the stack stays at the SDK default.
```

- [ ] **Step 3: Add the adaptive fixture**

Immediately after the tight fixture's `runFixture` block, add a second `it`
that runs the same program with NO `maxPages` override:

```ts
  it("reaches ENOMEM at production layout too", async () => {
    // ADAPTIVE FIXTURE. The same program at the layout real software gets: a
    // real __heap_base, the SDK's 8 MiB shadow stack, the default page budget.
    // The tight fixture proves the error paths are CORRECT; this one proves
    // they are still REACHABLE without a hand-constrained address space.
    // Nothing covered this before 2026-09-18.
    const result = await runFixture("programs/p_11_fork_continuation_enomem.wasm", {
      // no maxPages override
    });
    expect(result.stdout).toContain("PASS: P-11");
  });
```

Match the options object and assertion style of the existing `runFixture` call
in this file; copy its shape rather than inventing one.

- [ ] **Step 4: Run both**

```bash
npx vitest run host/test/fork-instrument-coverage.test.ts -t "p_11"
```

Expected: both PASS. If the adaptive fixture cannot fill the address space
within `MAX_FILLER_MAPPINGS` (512 in the C source), it will report
`FAIL: address-space fill count=512` — record that and report rather than
raising the limit.

- [ ] **Step 5: Perturb the tight fixture**

Raise its `maxPages` by 64 and re-run. Expected: it stops reaching `ENOMEM` and
fails. Restore by hand.

- [ ] **Step 6: Budget, then commit**

```bash
npx vitest run host/test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
git add host/test/fork-instrument-coverage.test.ts
git commit -m "Fork: P-11 gets a deliberate tight fixture and an adaptive one"
git push origin brandonpayton/lane-f-fork-inversion
```

---

### Task 10: Fail loud when a program admits without `__heap_base`

Sequenced AFTER Task 8 so the suite is never red on a defect the same phase
removes. `read_heap_base` (`crates/wasm-artifact/src/facts.rs`) returns `null`
when the export is absent, and the host silently falls back to
`PROCESS_MEMORY_FALLBACK_BRK_BASE` (16,777,216) — a silent penalty plus the
heap/shadow-stack overlap `crates/runtime-core/src/memory.rs:384-392` warns
about.

**Files:**
- Modify: `host/src/process-memory.ts` (`computeProcessMemoryLayout`)
- Test: `host/test/process-memory-layout.test.ts`

**Interfaces:**
- Consumes: `computeProcessMemoryLayout(options: ProcessMemoryLayoutOptions)`,
  already exported from `host/src/process-memory.ts`. The refusal goes HERE and
  not at the `extractHeapBase` call site in `process-lifecycle.ts:1317`: that
  call lives inside `createFreshProcessMemory`, a local unexported async
  function no test can reach, whereas this one is exported and already covered
  by `process-memory-layout.test.ts`.

- [ ] **Step 1: Write the failing test**

Append to `host/test/process-memory-layout.test.ts`:

```ts
it("refuses a real program whose heap base could not be read", () => {
  // A null heapBase used to mean a silent 16 MiB brk fallback plus the
  // heap/shadow-stack overlap `crates/runtime-core/src/memory.rs:384-392`
  // warns about. Every SDK-built program lacked `__heap_base` until the link
  // contract was unified, and the kernel comment asserting "for programs
  // built with our SDK this is always overridden" was false the whole time.
  const programBytes = readFileSync(
    "local-binaries/programs/wasm32/p_01_fork_main_thread.wasm",
  ).buffer as ArrayBuffer;
  expect(() =>
    computeProcessMemoryLayout({
      ptrWidth: 4,
      maxPages: 384,
      programBytes,
      heapBase: null,
    }),
  ).toThrow(/__heap_base/);
});

it("still serves a layout when no program is named at all", () => {
  // Absence of a PROGRAM is not absence of an EXPORT. A caller asking for a
  // layout without naming a program gets the documented empty-program answer,
  // not a refusal.
  expect(() =>
    computeProcessMemoryLayout({ ptrWidth: 4, maxPages: 384 }),
  ).not.toThrow();
});
```

Add `readFileSync` to the file's `node:fs` import if it is not already there.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/brandon/kandelo-lane-f
npx vitest run host/test/process-memory-layout.test.ts
```

Expected: the first new test FAILS (no error is thrown today); the second
passes already.

- [ ] **Step 3: Add the refusal**

In `host/src/process-memory.ts`, at the top of `computeProcessMemoryLayout`:

```ts
  // TRUTHFUL FAILURE over a convenient illusion. A named program whose
  // `__heap_base` could not be read used to get a silent 16 MiB brk fallback
  // (`PROCESS_MEMORY_FALLBACK_BRK_BASE`), plus the heap/shadow-stack overlap
  // `crates/runtime-core/src/memory.rs:384-392` describes for programs with a
  // large data section. A binary arriving without the export is a build that
  // went wrong, not a legacy artifact: there is no backwards compatibility
  // here, and instrumentation ships with the fork support that consumes it.
  //
  // Absence of a PROGRAM is different and stays supported: `EMPTY_PROGRAM`
  // below is the documented answer for a caller that names none.
  if (options.programBytes !== undefined && options.heapBase === null) {
    throw new Error(
      "process memory layout: the program exports no __heap_base, so its " +
        "initial program break cannot be derived. Rebuild it through the SDK " +
        "(sdk/bin/wasm32posix-cc); see docs/sdk-guide.md.",
    );
  }
```

- [ ] **Step 4: Run the full host suite**

```bash
cd host && npm run build && cd ..
npx vitest run host/test/ > /tmp/host-after.txt 2>&1
echo "SUITE_EXIT: $?"
grep -E "Test Files |Tests |FAIL" /tmp/host-after.txt
```

**Every program must now export `__heap_base`.** A fixture that does not will
fail here — that is the guard working. Fix the fixture's build (Task 11 covers
the remaining copies), never the guard.

- [ ] **Step 5: Perturb**

Change the condition to `if (false)` and re-run the new test. Expected: FAIL.
Restore by hand.

- [ ] **Step 6: Budget, then commit**

```bash
npx vitest run host/test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
git add host/src/process-memory.ts host/test/process-memory-layout.test.ts
git commit -m "Kernel: Refuse a program with no __heap_base instead of guessing"
git push origin brandonpayton/lane-f-fork-inversion
```

---

### Task 10b: Delete the dead brk constant and rule on the fallback's value

The spec's Thread B. `DEFAULT_BRK_RESERVE_PAGES = 256` in
`host/src/process-memory.ts:22` is marked `@deprecated` and referenced
NOWHERE — it was quoted repeatedly during design as if it were live. The
constant that is live is `PROCESS_MEMORY_FALLBACK_BRK_BASE = 16,777,216`
(kernel side: `MemoryManager::INITIAL_BRK = 0x01000000`).

**Files:**
- Modify: `host/src/process-memory.ts:22`
- Modify: `crates/runtime-core/src/memory.rs:66`

- [ ] **Step 1: Prove the constant is dead**

```bash
cd /Users/brandon/kandelo-lane-f
grep -rn "DEFAULT_BRK_RESERVE_PAGES" --include="*.ts" --include="*.rs" .   | grep -v node_modules
```

Expected: exactly one hit, its own definition. If there are more, it is not
dead — stop and report instead of deleting.

- [ ] **Step 2: Delete it**

Remove the three lines at `host/src/process-memory.ts:21-23`:

```ts
/** @deprecated brk and mmap are now coordinated by the kernel allocator. */
export const DEFAULT_BRK_RESERVE_PAGES = 256; // 16 MiB
```

- [ ] **Step 3: Correct the kernel's false assertion**

In `crates/runtime-core/src/memory.rs`, the `INITIAL_BRK` doc comment claims
"For programs built with our SDK this is always overridden before `_start`
runs". That was false for every SDK-built program until Task 8. Replace that
sentence with:

```rust
    /// Every program built through the SDK overrides this before `_start`
    /// runs, because `sdk/src/lib/flags.ts` exports `__heap_base` and the host
    /// refuses a named program without it (see
    /// `computeProcessMemoryLayout`). That was NOT true before 2026-09-18:
    /// `scripts/build-programs.sh` and six other files carried their own copy
    /// of the link contract and had lost the export, so every test program ran
    /// on this fallback and this comment asserted the opposite.
```

- [ ] **Step 4: Rebuild and run**

```bash
cargo build -p wasm-posix-runtime-core 2>&1 | tail -5
cd host && npm run build && cd ..
npx vitest run host/test/process-memory-layout.test.ts
```

Expected: PASS. A TypeScript build error naming
`DEFAULT_BRK_RESERVE_PAGES` means Step 1's grep missed a consumer.

- [ ] **Step 5: Budget, then commit**

```bash
npx vitest run host/test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
git add host/src/process-memory.ts crates/runtime-core/src/memory.rs
git commit -m "Kernel: Delete a dead brk constant and a false SDK assertion"
git push origin brandonpayton/lane-f-fork-inversion
```

**Left open for the maintainer:** what
`PROCESS_MEMORY_FALLBACK_BRK_BASE` should be now that it serves only the case
it documents rather than every program. Do not retune it in this plan — it is
now unreachable for named programs, so its value affects nothing until
something legitimately lacks the export.

---

### Task 11: Converge the remaining seven link-contract copies

Nine files hand-maintain `-Wl,--export=_start` and friends. Task 8 handled
`build-programs.sh`; `sdk/src/lib/flags.ts` is the authority and
`sdk/test/flags.test.ts` is its test.

Remaining: `scripts/run-browser-posix-tests.sh`,
`scripts/run-browser-sortix-tests.sh`,
`crates/host-native/fixtures/build-fixtures.sh`, `examples/dlopen/build.sh`,
`host/test/vfork-side-module-fixture.ts`,
`host/test/fork-from-dlopen-side-module-e2e.test.ts`,
`host/test/fork-dlopen-replay-e2e.test.ts`.

**Files:** the seven above.

- [ ] **Step 1: Diff each against the authority**

```bash
cd /Users/brandon/kandelo-lane-f
for f in scripts/run-browser-posix-tests.sh scripts/run-browser-sortix-tests.sh \
         crates/host-native/fixtures/build-fixtures.sh examples/dlopen/build.sh \
         host/test/vfork-side-module-fixture.ts \
         host/test/fork-from-dlopen-side-module-e2e.test.ts \
         host/test/fork-dlopen-replay-e2e.test.ts; do
  echo "=== $f ==="
  grep -oE '\-Wl,--?[a-z-]+(=[^ "]*)?' "$f" | sort -u > /tmp/have.txt
  grep -oE "'-Wl,--?[a-z-]+(=[^']*)?'" sdk/src/lib/flags.ts | tr -d "'" | sort -u > /tmp/want.txt
  echo "missing from this copy:"; comm -13 /tmp/have.txt /tmp/want.txt | sed 's/^/  /'
done
```

- [ ] **Step 2: Convert each to the SDK wrapper**

For each file, replace its direct `clang` invocation with
`sdk/bin/wasm32posix-cc` (or `wasm32posix-c++` for C++ sources) and delete its
`-Wl,` list, exactly as Task 8 did. Side-module builds keep their own
`-shared`/`-fPIC` flags, which the SDK does not supply.

Commit **one file per commit** so a regression is attributable:

```bash
npx vitest run host/test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
git add <the one file>
git commit -m "Build: Route <name> through the SDK, deleting a flag copy"
git push origin brandonpayton/lane-f-fork-inversion
```

- [ ] **Step 3: Prove no copy remains**

```bash
grep -rln "Wl,--export=_start" --include="*.sh" --include="*.ts" . \
  | grep -v node_modules
```

Expected: only `sdk/src/lib/flags.ts` and `sdk/test/flags.test.ts`.

- [ ] **Step 4: Full suite, both hosts considered**

```bash
cd host && npm run build && cd ..
./run.sh test 2>&1 | tail -30
```

Browser-facing programs changed, so `CLAUDE.md`'s host-parity contract applies:
record whether `./run.sh browser` was run and what it showed, or state plainly
that it was not.

- [ ] **Step 5: Final commit**

```bash
npx vitest run host/test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
git commit --allow-empty -m "Build: One link contract, nine copies retired"
git push origin brandonpayton/lane-f-fork-inversion
```

---

## What this plan does NOT cover

Changes 2 and 3 from the spec get their own plans, written after this one
lands, because both are sized against a memory layout this plan changes:

- **Change 2 — resume-table import.** The module imports the host's resume
  table and places thunks itself; `fm_resume_slots` op 0 and `resume_slot_of`
  are removed; `abi/snapshot.json` regenerated.
- **Change 3 — storage conversion.** Eleven stores onto a shared chain, two
  more chains for the guest-reachable scratch and vector stacks, the heap floor
  to zero, the staging slab resized, the directory with its own root.
