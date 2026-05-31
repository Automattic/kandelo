# Fork-Instrument Phase 6 Fuzzing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Set up `cargo-fuzz` for `crates/fork-instrument` with a typed random-WAT generator targeting `try_table` + `catch_ref` shapes, and a dual-validator oracle (walrus + wasmparser). Gate Phase 7 rollout on ≥10,000 iterations with zero validator failures, per design §5.4.

**Architecture:** Separate `fuzz/` subcrate inside `crates/fork-instrument/` (standard `cargo fuzz` layout; excluded from the outer workspace so it can target host-darwin while the workspace targets wasm64). One fuzz target file, `fuzz_try_table.rs`, with a typed `Arbitrary` generator module (`generator.rs`) that deterministically emits small WAT programs with try_table / catch / catch_ref / catch_all_ref shapes on a fork path. The fuzz target's oracle: (1) parse generator WAT to bytes; (2) sanity-check input validity with wasmparser (skip invalid inputs — they mean the generator is buggy but don't count as instrumentation findings); (3) call `fork_instrument::instrument`; (4) validate output with both `wasmparser::Validator` (independent) and `walrus::Module::from_buffer` (re-parse; walrus performs its own validation pass). Any step-3 panic or step-4 failure is a finding.

**Tech Stack:**
- `cargo-fuzz` (libFuzzer backend, requires nightly — we have it)
- `arbitrary` crate (derive-based typed input generation; avoids raw-bytes rejection-sampling)
- `wasmparser` (independent validator)
- `walrus` (re-parse oracle)
- `wat` (WAT text → bytes compiler)

---

## Background and constraints

1. **Workspace target is wasm64.** `.cargo/config.toml` sets `build.target = "wasm64-unknown-unknown"`. fork-instrument itself builds with `--target aarch64-apple-darwin`. The fuzz subcrate must do the same, either via its own `.cargo/config.toml` override or via the invoker supplying `--target`.

2. **`cargo fuzz` convention.** `cargo fuzz init` scaffolds `fuzz/` next to `src/`. That subdirectory has its own `Cargo.toml` with `[[workspace]]` (empty table) to detach from the parent workspace.

3. **libFuzzer on macOS arm64 — ASAN must be disabled.** `cargo fuzz`'s default sanitizer is AddressSanitizer. On Apple Silicon with recent Rust nightlies, the ASAN runtime deadlocks during init: its malloc interceptor recurses back through ASAN init, which is already holding the init spin-mutex. Every fuzz invocation must pass `--sanitizer=none`. That flag disables ASAN but leaves libFuzzer's SanitizerCoverage instrumentation intact, so coverage-guided mutation still works. This matches the design §5.4 framing — we're fuzzing for semantic/validator divergence, not memory-safety bugs. The runner script (Task 10) encodes this flag so callers don't have to remember.

4. **Oracle philosophy (design §5.4):** "walrus's validator catches ill-formed outputs; we're fuzzing for semantic divergence, not crash resistance." MVP goal: prove instrumentation preserves wasm validity across a broad input distribution. Semantic-equivalence fuzzing (instantiate + run) is explicitly deferred — the design says "for a subset" and doesn't require it for the 10k gate. Do not implement runtime differential fuzzing in this pass.

5. **Budget-capped runs.** `cargo fuzz run <target> -- -runs=N` runs exactly N iterations and exits 0 on clean. We'll hit 10k this way, not an open-ended fuzz session.

6. **Reproducibility.** Generator uses `arbitrary::Arbitrary`; each finding serializes to a reproducible corpus artifact under `fuzz/artifacts/<target>/`. Commit the corpus and any repro-test back to the tree.

7. **Deterministic WAT emission.** Generator emits textual WAT (via a small formatter), then `wat::parse_str` compiles it. Reasons: (a) easier debugging — `fuzz/artifacts/` entries decode to readable source, (b) the existing test layer already uses this pipeline, (c) avoids re-implementing wasm encoding.

8. **Feature flags.** The existing test validator uses `wasmparser::WasmFeatures::default()`, which enables exception handling, reference types, GC, SIMD, etc. as of wasmparser 0.247. We keep the same defaults.

9. **Fork-path reachability.** The instrumentation is a no-op when the module doesn't import `kernel.kernel_fork`. Every generator output must import that symbol and have at least one (possibly transitive) call from an exported function to it — otherwise we're not fuzzing what we claim to be fuzzing.

---

## Success criteria

- `cargo fuzz run fuzz_try_table -- -runs=10000 -max_len=4096` exits 0.
- Any crash/validation finding during plan execution is either (a) a generator bug (fix generator, no corpus entry) or (b) an instrumentor bug (fix instrumentor, commit artifact to corpus, add unit test).
- Running the fuzz target is documented in `crates/fork-instrument/README.md` and the project memory file.
- No change to existing 72 unit tests — they must still pass.
- PR #307 is updated with the fuzzing infrastructure; Phase 7 rollout remains out of scope.

---

## Task 1: Install cargo-fuzz

**Files:** none (tool install).

**Step 1:** Install cargo-fuzz globally (one-time).

Run: `cargo install cargo-fuzz`
Expected: succeeds, `~/.cargo/bin/cargo-fuzz` installed.

**Step 2:** Verify.

Run: `cargo fuzz --version`
Expected: prints version (≥0.12).

**Step 3:** No commit — this is environment setup.

---

## Task 2: Scaffold the fuzz subcrate

**Files:**
- Create: `crates/fork-instrument/fuzz/Cargo.toml`
- Create: `crates/fork-instrument/fuzz/fuzz_targets/fuzz_try_table.rs` (stub)
- Create: `crates/fork-instrument/fuzz/.gitignore`
- Create: `crates/fork-instrument/fuzz/.cargo/config.toml`

**Step 1:** `cd crates/fork-instrument && cargo fuzz init --target fuzz_try_table`

This creates `fuzz/Cargo.toml`, `fuzz/fuzz_targets/fuzz_try_table.rs`, and `fuzz/.gitignore`. Do NOT run `cargo fuzz build` yet — we need to fix up Cargo.toml first.

**Step 2:** Replace `fuzz/Cargo.toml` contents:

```toml
[package]
name = "fork-instrument-fuzz"
version = "0.0.0"
publish = false
edition = "2024"

[package.metadata]
cargo-fuzz = true

[dependencies]
libfuzzer-sys = "0.4"
arbitrary = { version = "1", features = ["derive"] }
walrus = "0.26"
wasmparser = "0.247"
wat = "1"

[dependencies.fork-instrument]
path = ".."

# Detach from the repo's wasm64-defaulting workspace so this crate
# builds for the host without build-std dances. Empty `[workspace]`
# table makes this crate its own workspace root.
[workspace]

[profile.release]
debug = 1

[[bin]]
name = "fuzz_try_table"
path = "fuzz_targets/fuzz_try_table.rs"
test = false
doc = false
bench = false
```

**Step 3:** Create `fuzz/.cargo/config.toml` so `cargo fuzz run` targets the host (not the workspace's wasm64 default):

```toml
[build]
target = "aarch64-apple-darwin"
```

**Step 4:** Replace the generated `fuzz/fuzz_targets/fuzz_try_table.rs` with a stub target that always returns early (we'll implement the oracle in Task 4):

```rust
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|_data: &[u8]| {
    // Stub: implemented in Task 4.
});
```

**Step 5:** Verify cargo fuzz can build the stub.

Run: `cd crates/fork-instrument && cargo fuzz build fuzz_try_table`
Expected: builds cleanly. Emits `fuzz/target/<triple>/release/fuzz_try_table`.

**Step 6:** Confirm the outer workspace still builds.

Run from repo root: `cargo build -p fork-instrument --target aarch64-apple-darwin`
Expected: succeeds, no change to the crate's own build.

**Step 7:** Commit.

```bash
git add crates/fork-instrument/fuzz
git commit -m "feat(fork-instrument): scaffold cargo-fuzz subcrate for Phase 6 fuzzing"
```

---

## Task 3: Seed corpus with existing fixtures

**Files:**
- Create: `crates/fork-instrument/fuzz/corpus/fuzz_try_table/` (dir)
- Create: `crates/fork-instrument/fuzz/seed_corpus.sh` (helper script)

Note: we'll change the corpus format in Task 5 once the Arbitrary generator lands. For now this is a byte-level smoke-test seed so the infrastructure is exercised end-to-end before we commit to an input schema.

**Step 1:** Write a seed helper `fuzz/seed_corpus.sh`:

```bash
#!/usr/bin/env bash
# Regenerates fuzz/corpus/fuzz_try_table/ from a curated list of WAT
# fixtures compiled to raw wasm bytes. Safe to re-run.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/corpus/fuzz_try_table"
rm -rf "$OUT"
mkdir -p "$OUT"

wat_to_bytes() {
    # Uses the `wat2wasm` binary from wabt if available, else falls
    # back to a tiny Rust one-liner via `cargo run -p fork-instrument`.
    # Keep simple for now: require wabt.
    local in="$1"
    local out="$2"
    wat2wasm "$in" -o "$out"
}

# Seed 1: minimal fork import (Phase 1 fixture).
wat_to_bytes /dev/stdin "$OUT/seed_trivial.wasm" <<'EOF'
(module
  (import "kernel" "kernel_fork" (func $fork (result i32)))
  (func $main (export "_start") (result i32) call $fork)
  (memory 1))
EOF

# Seed 2: fork inside try_table body with catch_ref (Phase 6 fixture).
wat_to_bytes /dev/stdin "$OUT/seed_try_catch_ref.wasm" <<'EOF'
(module
  (import "kernel" "kernel_fork" (func $fork (result i32)))
  (tag $exn)
  (func $caller (export "caller") (result i32)
    (block $handler (result (ref null exn))
      (try_table (result (ref null exn)) (catch_ref $exn $handler)
        call $fork drop ref.null exn))
    drop i32.const 0)
  (memory 1))
EOF

echo "Seeded $(ls "$OUT" | wc -l) corpus entries in $OUT"
```

**Step 2:** Make executable and run.

```bash
chmod +x crates/fork-instrument/fuzz/seed_corpus.sh
crates/fork-instrument/fuzz/seed_corpus.sh
```

Expected: two `.wasm` files land under `fuzz/corpus/fuzz_try_table/`.

If `wat2wasm` is not installed, install via `brew install wabt`. Document this prerequisite in Task 9.

**Step 3:** Add `fuzz/corpus/` to `.gitignore` for the fuzz subcrate (corpus grows during fuzzing and shouldn't be committed wholesale). Commit only the `seed_corpus.sh` script and the two `seed_*.wasm` as a minimum reproducer set.

Actually: commit nothing from corpus at this step. Corpus grows during fuzz runs, and reproducing a run from a seed script is cleaner than vendoring binary blobs. Add to `fuzz/.gitignore`:

```gitignore
corpus/
artifacts/
target/
```

**Step 4:** Commit.

```bash
git add crates/fork-instrument/fuzz/.gitignore crates/fork-instrument/fuzz/seed_corpus.sh
git commit -m "feat(fork-instrument): add fuzz corpus seeding script"
```

---

## Task 4: Implement the validator oracle (raw-bytes mode)

**Files:**
- Create: `crates/fork-instrument/fuzz/fuzz_targets/oracle.rs` (shared helper module, used by the fuzz target via `#[path]`)
- Modify: `crates/fork-instrument/fuzz/fuzz_targets/fuzz_try_table.rs`

**Step 1:** Write `fuzz/fuzz_targets/oracle.rs`:

```rust
//! Dual-validator oracle for fork-instrument fuzzing.
//!
//! Given a wasm binary `bytes`, runs the instrumenter and asserts the
//! output validates under both wasmparser (independent) and walrus
//! (re-parse). Any instrumenter panic or validator rejection of the
//! output is a finding.
//!
//! `preflight_bytes` is a cheap input filter: if the generator produced
//! garbage that doesn't validate as wasm in the first place, the
//! instrumenter is not under test for that input and we bail silently.

use fork_instrument::{Options, instrument};

pub fn preflight_bytes(bytes: &[u8]) -> bool {
    let mut v = wasmparser::Validator::new_with_features(
        wasmparser::WasmFeatures::default(),
    );
    v.validate_all(bytes).is_ok()
}

pub fn run_oracle(bytes: &[u8]) {
    if !preflight_bytes(bytes) {
        return;
    }
    let output = match instrument(bytes, &Options::default()) {
        Ok(o) => o,
        Err(e) => panic!("instrument() returned error: {e:#}"),
    };
    // Oracle #1: independent wasmparser validator.
    let mut v = wasmparser::Validator::new_with_features(
        wasmparser::WasmFeatures::default(),
    );
    v.validate_all(&output)
        .expect("instrumented output failed wasmparser validation");
    // Oracle #2: walrus re-parse (also validates as a side effect).
    walrus::Module::from_buffer(&output)
        .expect("instrumented output failed walrus re-parse");
}
```

**Step 2:** Update `fuzz/fuzz_targets/fuzz_try_table.rs` to call the oracle on raw bytes (we'll swap to the Arbitrary generator in Task 6):

```rust
#![no_main]
use libfuzzer_sys::fuzz_target;

#[path = "oracle.rs"]
mod oracle;

fuzz_target!(|data: &[u8]| {
    oracle::run_oracle(data);
});
```

**Step 3:** Run a short smoke test against the seed corpus.

Run: `cd crates/fork-instrument && cargo fuzz run fuzz_try_table -- -runs=200 -max_len=4096`
Expected: completes 200 iterations, exit 0. The seed corpus entries exercise the instrumentation path; the rest are libFuzzer mutations. Some (most) mutated inputs will fail `preflight_bytes` and return early — that's fine.

**Step 4:** Commit.

```bash
git add crates/fork-instrument/fuzz/fuzz_targets
git commit -m "feat(fork-instrument): add raw-bytes fuzz oracle (walrus + wasmparser)"
```

---

## Task 5: Write the typed WAT generator — minimal shape

**Files:**
- Create: `crates/fork-instrument/fuzz/fuzz_targets/generator.rs`
- Create: `crates/fork-instrument/fuzz/fuzz_targets/generator_tests.rs` (unit tests via a regular `[[bin]]`? No — unit-test via a hidden binary. Alternative: put generator in a `lib` crate. For MVP, skip unit tests here; the fuzz target itself validates every generated input via preflight.)

**Step 1:** Write `fuzz/fuzz_targets/generator.rs`. Start with ONE shape:

A module with:
- `(import "kernel" "kernel_fork" (func $fork (result i32)))`
- One `(tag $exn)`
- One fork-path function `(func $caller (export "caller") (result i32) ...)`
- Its body is: `(block $handler (result (ref null exn)) (try_table (result (ref null exn)) <CATCH_CLAUSE> call $fork drop ref.null exn)) drop i32.const 0`
- `<CATCH_CLAUSE>` is one of: `(catch_ref $exn $handler)`, `(catch_all_ref $handler)`, `(catch $exn $handler) -- but $handler result type must then be i32 empty, not (ref null exn)`. To keep the generator single-shape at first, pin `<CATCH_CLAUSE>` to `(catch_ref $exn $handler)` for this task.

Code:

```rust
//! Typed WAT generator for fork-instrument fuzzing.
//!
//! Deterministically emits a WAT program from an `Arbitrary` input.
//! Every generator output is a syntactically well-formed module that
//! imports `kernel.kernel_fork` so the instrumenter has work to do.
//!
//! This file starts narrow: one try_table shape with a catch_ref
//! clause on the fork path. Subsequent tasks extend the input space
//! (nested try_tables, ref-typed locals, multi-function fork paths).

use arbitrary::{Arbitrary, Unstructured};

/// One generated program. Keep fields private so future generator
/// extensions don't require downstream changes.
#[derive(Debug)]
pub struct WatProgram {
    /// 0..=3 extra i32 locals in the fork-path function. Ensures we
    /// exercise frame-save/restore for varying scalar-local counts.
    extra_i32_locals: u8,
    /// When true, prepend a `(memory.grow)` noop in the fork-path body
    /// to exercise Phase 4g's gating of memory-mutation ops.
    has_memory_grow: bool,
}

impl<'a> Arbitrary<'a> for WatProgram {
    fn arbitrary(u: &mut Unstructured<'a>) -> arbitrary::Result<Self> {
        Ok(Self {
            extra_i32_locals: u8::arbitrary(u)? & 0b11, // 0..=3
            has_memory_grow: bool::arbitrary(u)?,
        })
    }
}

impl WatProgram {
    /// Render this program as WAT source text. Always syntactically
    /// valid; type-validity is confirmed by the preflight step in the
    /// oracle.
    pub fn to_wat(&self) -> String {
        let mut locals = String::new();
        for _ in 0..self.extra_i32_locals {
            locals.push_str("(local i32) ");
        }

        let mem_grow = if self.has_memory_grow {
            "i32.const 0 memory.grow drop"
        } else {
            ""
        };

        format!(
            r#"(module
  (import "kernel" "kernel_fork" (func $fork (result i32)))
  (tag $exn)
  (func $caller (export "caller") (result i32)
    {locals}
    (block $handler (result (ref null exn))
      (try_table (result (ref null exn)) (catch_ref $exn $handler)
        {mem_grow}
        call $fork
        drop
        ref.null exn))
    drop
    i32.const 0)
  (memory 1))
"#,
            locals = locals,
            mem_grow = mem_grow,
        )
    }

    /// Render to bytes. Returns `None` on unusual wat parse failures
    /// (should be rare; generator is meant to produce valid syntax).
    pub fn to_bytes(&self) -> Option<Vec<u8>> {
        wat::parse_str(&self.to_wat()).ok()
    }
}
```

**Step 2:** Rewrite `fuzz_try_table.rs` to use the generator via `Arbitrary`:

```rust
#![no_main]
use libfuzzer_sys::fuzz_target;

#[path = "oracle.rs"]
mod oracle;

#[path = "generator.rs"]
mod generator;

use generator::WatProgram;

fuzz_target!(|prog: WatProgram| {
    let Some(bytes) = prog.to_bytes() else { return };
    oracle::run_oracle(&bytes);
});
```

**Step 3:** Nuke the old raw-byte corpus (schema is now Arbitrary-encoded bytes, not wasm). libFuzzer will seed from scratch:

```bash
rm -rf crates/fork-instrument/fuzz/corpus crates/fork-instrument/fuzz/artifacts
```

**Step 4:** Smoke test — 500 runs.

Run: `cd crates/fork-instrument && cargo fuzz run fuzz_try_table -- -runs=500 -max_len=32`
Expected: completes, exit 0. Inputs are small (only two bits and one u8 are consumed per generator, so `max_len=32` is generous).

**Step 5:** Commit.

```bash
git add crates/fork-instrument/fuzz/fuzz_targets
git commit -m "feat(fork-instrument): typed WAT generator with catch_ref shape"
```

---

## Task 6: Extend the generator — clause variants

**Files:** Modify `crates/fork-instrument/fuzz/fuzz_targets/generator.rs`

**Step 1:** Extend `WatProgram` with a `clause_variant` field:

```rust
#[derive(Debug, Clone, Copy, Arbitrary)]
enum ClauseVariant {
    /// (catch_ref $exn $handler) — handler receives exnref.
    CatchRef,
    /// (catch_all_ref $handler) — handler receives exnref.
    CatchAllRef,
    /// (catch $exn $handler) — handler receives nothing.
    Catch,
    /// (catch_all $handler) — handler receives nothing.
    CatchAll,
}
```

Handler block type must match the clause:
- `CatchRef`, `CatchAllRef` → handler yields `(ref null exn)`, body drops + pushes `ref.null exn`
- `Catch`, `CatchAll` → handler yields no value; body just pushes nothing

**Step 2:** Rewrite `to_wat` to switch on `clause_variant`. Keep a single try_table, single handler, always on the fork path.

Sketch:

```rust
let (clause_wat, block_result_ty, body_yield, handler_cleanup) = match self.clause_variant {
    ClauseVariant::CatchRef => (
        "(catch_ref $exn $handler)",
        "(result (ref null exn))",
        "ref.null exn",  // body yields exnref
        "drop",          // handler drops
    ),
    ClauseVariant::CatchAllRef => (
        "(catch_all_ref $handler)",
        "(result (ref null exn))",
        "ref.null exn",
        "drop",
    ),
    ClauseVariant::Catch => (
        "(catch $exn $handler)",
        "",   // block has no result
        "",   // body yields nothing
        "",
    ),
    ClauseVariant::CatchAll => (
        "(catch_all $handler)",
        "",
        "",
        "",
    ),
};

format!(
    r#"(module
  (import "kernel" "kernel_fork" (func $fork (result i32)))
  (tag $exn)
  (func $caller (export "caller") (result i32)
    {locals}
    (block $handler {block_result_ty}
      (try_table {block_result_ty} {clause_wat}
        {mem_grow}
        call $fork
        drop
        {body_yield}))
    {handler_cleanup}
    i32.const 0)
  (memory 1))
"#,
    ...
)
```

**Step 3:** Smoke test — 1,000 runs.

Run: `cd crates/fork-instrument && cargo fuzz run fuzz_try_table -- -runs=1000 -max_len=32`
Expected: exit 0.

**Step 4:** Commit.

```bash
git commit -am "feat(fork-instrument): fuzz generator covers all catch clause variants"
```

---

## Task 7: Extend generator — nested try_tables + locals of varied types

**Files:** Modify `crates/fork-instrument/fuzz/fuzz_targets/generator.rs`

**Step 1:** Add a `nested` field.

```rust
/// When true, wrap the fork call in a second (outer) try_table with
/// its own clause variant. Exercises Phase 6a-e region-id assignment
/// and handler dispatch across multiple regions.
nested_outer: Option<ClauseVariant>,
```

When `Some`, emit:

```wat
(block $outer_handler <result>
  (try_table <result> <outer_clause>
    (block $handler <result>
      (try_table <result> <inner_clause>
        call $fork drop <body_yield>))
    <handler_cleanup>
    ;; outer body yields same as inner
    <body_yield>))
<handler_cleanup>  ;; for outer
```

Keep block result types consistent — easiest: always pin both try_tables to the same clause family (ref-variants or value-variants), so the generator picks `nested_outer` only when it matches `clause_variant`'s arity.

**Step 2:** Add varied scalar locals:

```rust
/// Sequence of local types to inject into the fork-path function.
/// Up to 4 locals chosen from {i32, i64, f32, f64}. Exercises 4d
/// scalar-local spilling at varying alignments.
scalar_locals: Vec<ScalarLocalTy>,

#[derive(Debug, Clone, Copy, Arbitrary)]
enum ScalarLocalTy { I32, I64, F32, F64 }
```

Cap the length at 4 in the `Arbitrary` impl so generator inputs stay bounded. Render each as `(local <ty>)` in the function header.

**Step 3:** Smoke test — 2,000 runs.

Run: `cd crates/fork-instrument && cargo fuzz run fuzz_try_table -- -runs=2000 -max_len=64`
Expected: exit 0.

If any finding surfaces, stop the plan and triage: is it a generator bug (invalid WAT passes syntax but fails preflight — fine, oracle bails) or an instrumentor bug (output fails walrus/wasmparser — fix instrumentor, add a unit test that reproduces from the artifact WAT, commit separately).

**Step 4:** Commit.

```bash
git commit -am "feat(fork-instrument): fuzz generator covers nested try_tables + varied locals"
```

---

## Task 8: Extend generator — ref-typed locals + indirect calls

**Files:** Modify `crates/fork-instrument/fuzz/fuzz_targets/generator.rs`

**Step 1:** Add ref-typed locals.

```rust
/// 0..=2 ref-typed locals. Exercises 4f aux-table spill + Phase 6's
/// captured_exnref_K non-spill invariant.
ref_locals: Vec<RefLocalTy>,

#[derive(Debug, Clone, Copy, Arbitrary)]
enum RefLocalTy { FuncRef, ExternRef, ExnRef }
```

Emit each as `(local (ref null <ty>))`. They don't need to be used — their presence forces 4f's aux-table injection and Phase 6's captured-exnref handling.

**Step 2:** Add an optional indirect-call seed.

```rust
/// When true, add a second function `$inner_fork` which is NOT
/// exported, has a (table) entry, and is invoked via call_indirect
/// from `$caller`. Exercises 3a/3b indirect-call closure.
has_indirect_call: bool,
```

When true, emit:

```wat
(module
  (import "kernel" "kernel_fork" (func $fork (result i32)))
  (tag $exn)
  (func $inner_fork (result i32) call $fork)
  (table 1 1 funcref)
  (elem (i32.const 0) $inner_fork)
  (type $ft (func (result i32)))
  (func $caller (export "caller") (result i32)
    ...
    (call_indirect (type $ft) (i32.const 0))
    ...))
```

**Step 3:** Smoke test — 3,000 runs.

Run: `cd crates/fork-instrument && cargo fuzz run fuzz_try_table -- -runs=3000 -max_len=96`
Expected: exit 0.

Findings → triage as in Task 7.

**Step 4:** Commit.

```bash
git commit -am "feat(fork-instrument): fuzz generator covers ref locals + indirect calls"
```

---

## Task 9: Run the 10k gate

**Files:** none (run + triage only).

**Step 1:** Full 10k run.

Run: `cd crates/fork-instrument && cargo fuzz run fuzz_try_table -- -runs=10000 -max_len=128`
Expected: libFuzzer reports "Done 10000 runs in <N> second(s)", exit 0.

If any finding surfaces:
- libFuzzer writes the artifact to `fuzz/artifacts/fuzz_try_table/crash-<hash>`.
- Read the artifact as Arbitrary bytes: `cargo fuzz fmt fuzz_try_table fuzz/artifacts/fuzz_try_table/crash-<hash>` prints the decoded `WatProgram`.
- Reproduce in isolation: `cargo fuzz run fuzz_try_table fuzz/artifacts/fuzz_try_table/crash-<hash>`.
- File a fix and add a fixture-level unit test under `crates/fork-instrument/tests/instrument.rs` derived from the WAT the artifact decodes to.
- Loop back to Step 1 after fix is committed.

**Step 2:** Record output.

Capture the final libFuzzer summary line (e.g. `#10000 DONE cov: N ft: M corp: X/Y exec/s: Z`) and paste it into the commit message for Task 11.

**Step 3:** No commit — this is a verification run. Commit comes with Task 11 docs update.

---

## Task 10: Wire a convenience runner + CI-friendly invocation

**Files:**
- Create: `scripts/run-fork-instrument-fuzz.sh`

**Step 1:** Write the script:

```bash
#!/usr/bin/env bash
# Runs the fork-instrument Phase 6 fuzzer for a fixed iteration budget.
# Defaults to the §5.4 gate value (10000). Override with FUZZ_RUNS=<N>.
set -euo pipefail

RUNS="${FUZZ_RUNS:-10000}"
MAX_LEN="${FUZZ_MAX_LEN:-128}"

cd "$(dirname "$0")/../crates/fork-instrument"

exec cargo fuzz run fuzz_try_table -- \
    -runs="$RUNS" \
    -max_len="$MAX_LEN"
```

**Step 2:** Make executable.

Run: `chmod +x scripts/run-fork-instrument-fuzz.sh`

**Step 3:** Smoke test with short budget.

Run: `FUZZ_RUNS=200 scripts/run-fork-instrument-fuzz.sh`
Expected: completes in seconds, exit 0.

**Step 4:** Commit.

```bash
git add scripts/run-fork-instrument-fuzz.sh
git commit -m "feat(fork-instrument): add scripts/run-fork-instrument-fuzz.sh"
```

---

## Task 11: Documentation + memory update

**Files:**
- Modify: `crates/fork-instrument/README.md`
- Modify: `~/.claude/projects/-Users-brandon-ai-src-kandelo/memory/fork-instrument-project.md`

**Step 1:** Append a "Fuzzing" section to `crates/fork-instrument/README.md`:

```markdown
## Fuzzing (Phase 6 gate)

Phase 6 catch-handler resume is validated against a random-WAT fuzzer
with a dual walrus + wasmparser oracle. Per design §5.4, ≥10 000
iterations must complete with zero validator failures before Phase 6
is declared shippable.

Prerequisites: `cargo install cargo-fuzz` (one-time; requires nightly,
which `rust-toolchain.toml` already pins).

Short invocation:

```sh
FUZZ_RUNS=10000 scripts/run-fork-instrument-fuzz.sh
```

Direct invocation for a custom budget:

```sh
cd crates/fork-instrument
cargo fuzz run fuzz_try_table -- -runs=10000 -max_len=128
```

Findings land in `crates/fork-instrument/fuzz/artifacts/`. Decode with
`cargo fuzz fmt fuzz_try_table <artifact>` to see the `WatProgram`
struct that triggered the finding. Any finding MUST be converted into
a unit-level fixture in `tests/instrument.rs` before being closed.
```

**Step 2:** Update the project memory file to mark fuzzing complete. Replace the "Phase 6 fuzzing" bullet in `Current status` with something like:

```markdown
**Phases complete:** 1, 2, 3, 4a–g, 6a–e, and Phase 6 fuzzing (10 000
iterations clean on <date>).
**Phases remaining:** 7 (production rollout). Multi-target `*_ref`
try_tables still skipped; revisit if a real program forces it.
```

Do NOT claim fuzzing complete unless Task 9 actually exited 0. If it didn't (and findings remain un-fixed), stop here and report.

**Step 3:** Commit.

```bash
git add crates/fork-instrument/README.md
git commit -m "docs(fork-instrument): document Phase 6 fuzz runner and §5.4 gate"
```

Then save memory (via the auto-memory mechanism — edit the `.md` directly, no git commit for memory files).

---

## Task 12: Full regression suite before pushing

Per CLAUDE.md, run all five suites before claiming PR #307 ready for Phase 7. Since PR #307 is already passing these, the fuzzing additions should not regress any of them — but the fuzzing subcrate builds with a different target and must be sanity-checked.

**Step 1:** Cargo tests.

Run: `cargo test -p kandelo --target aarch64-apple-darwin --lib`
Expected: 707+ pass, 0 fail.

**Step 2:** fork-instrument unit tests.

Run: `cargo test -p fork-instrument --target aarch64-apple-darwin`
Expected: 72+ pass, 0 fail.

**Step 3:** vitest.

Run: `cd host && npx vitest run`
Expected: 290+ pass.

**Step 4:** libc-test.

Run: `scripts/run-libc-tests.sh`
Expected: 0 unexpected FAIL; XFAIL / TIME acceptable.

**Step 5:** POSIX test suite.

Run: `scripts/run-posix-tests.sh`
Expected: 0 FAIL.

**Step 6:** ABI snapshot.

Run: `bash scripts/check-abi-version.sh`
Expected: exit 0. No ABI change in this branch.

**Step 7:** If all pass, push branch + update PR.

```bash
git push origin fierce-wire
gh pr view 307 --web  # confirm CI picks up the push
```

Then add a PR comment describing the fuzzing gate results (iterations run, any findings + fixes).

---

## Out of scope for this plan

- Differential runtime fuzzing (instantiate + run pre- and post-instrument, compare stdout/memory). Design §5.4 says "for a subset" but doesn't gate the 10k goal on it. Revisit if Phase 7 rollout surfaces bugs our validator oracle missed.
- Multi-target `*_ref` try_table support (currently skipped in Phase 6d). Separate fix; revisit when a real program forces the issue.
- Coverage-guided corpus curation / long-running nightly fuzz runs. One-shot `-runs=10000` is the ship gate; continuous fuzzing can be a follow-up.
- Phase 7 (rollout): switching build scripts off asyncify, renaming exports, removing asyncify-onlylist files, removing the binaryen submodule. Separate plan.
