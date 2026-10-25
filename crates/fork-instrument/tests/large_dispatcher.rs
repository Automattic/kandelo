use fork_instrument::{Options, instrument};

use walrus::ir::{self, Instr};

use walrus::{FunctionKind, LocalFunction, Module};

/// Generate a WAT module containing a single `$dispatcher` function with
/// `n` consecutive top-level direct calls to `kernel.kernel_fork`.
///
/// This is the simplest possible shape that exercises the per-call-site
/// nested-block emission. A real binary's pathological case is
/// `call_indirect`-driven (see `wat_indirect_dispatcher`), but a chain of
/// N direct fork calls produces the same structural symptom and isolates
/// the per-call-site nesting from any indirect-closure noise.
fn wat_direct_dispatcher(n: usize) -> String {
    let mut body = String::new();
    for i in 0..n {
        body.push_str("        call $fork\n");
        if i + 1 < n {
            body.push_str("        drop\n");
        }
    }
    format!(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $dispatcher (export "dispatcher") (result i32)
{body}          )
          (memory 1))
        "#
    )
}

/// Generate a WAT module mimicking the wordpress-playground pattern:
/// a `$fork_target` that calls `$fork`, lives in a table at slot 0, and a
/// `$dispatcher` function with `n` `call_indirect` sites against that
/// table with `$fork_target`'s signature.
///
/// `reaching_closure` adds `$dispatcher` to the fork-path via the
/// `(table, sig)` indirect step, so it gets instrumented and runs into
/// the same nested-block blow-up.
fn wat_indirect_dispatcher(n: usize) -> String {
    let mut body = String::new();
    for i in 0..n {
        body.push_str("        i32.const 0\n");
        body.push_str("        call_indirect (type $ft)\n");
        if i + 1 < n {
            body.push_str("        drop\n");
        }
    }
    format!(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 1 funcref)
          (elem (i32.const 0) $fork_target)
          (func $fork_target (export "fork_target") (result i32)
            call $fork)
          (func $dispatcher (export "dispatcher") (result i32)
{body}          )
          (memory 1))
        "#
    )
}

fn instrument_wat(wat: &str) -> Vec<u8> {
    let bytes = wat::parse_str(wat).expect("wat parse");
    instrument(&bytes, &Options::default()).expect("instrument")
}

/// Maximum structured-control nesting depth reachable in `func`.
fn max_nesting_depth(func: &LocalFunction) -> usize {
    fn walk(func: &LocalFunction, seq: walrus::ir::InstrSeqId, depth: usize) -> usize {
        let mut best = depth;
        for (instr, _) in &func.block(seq).instrs {
            let children: Vec<walrus::ir::InstrSeqId> = match instr {
                Instr::Block(ir::Block { seq }) | Instr::Loop(ir::Loop { seq }) => vec![*seq],
                Instr::IfElse(ir::IfElse {
                    consequent,
                    alternative,
                }) => vec![*consequent, *alternative],
                Instr::TryTable(ir::TryTable { seq, .. }) => vec![*seq],
                _ => Vec::new(),
            };
            for child in children {
                let child_depth = walk(func, child, depth + 1);
                if child_depth > best {
                    best = child_depth;
                }
            }
        }
        best
    }
    walk(func, func.entry_block(), 0)
}

fn dispatcher_max_depth(bytes: &[u8]) -> usize {
    let module = Module::from_buffer(bytes).expect("parse instrumented");
    let func = module
        .funcs
        .iter()
        .find(|f| f.name.as_deref() == Some("dispatcher"))
        .expect("dispatcher missing from instrumented module");
    let FunctionKind::Local(local) = &func.kind else {
        panic!("dispatcher should be local");
    };
    max_nesting_depth(local)
}

fn dispatcher_call_count(bytes: &[u8]) -> usize {
    let module = Module::from_buffer(bytes).expect("parse instrumented");
    let func = module
        .funcs
        .iter()
        .find(|f| f.name.as_deref() == Some("dispatcher"))
        .expect("dispatcher missing");
    let FunctionKind::Local(local) = &func.kind else {
        panic!("dispatcher should be local");
    };
    let mut count = 0usize;
    fn walk(func: &LocalFunction, seq: walrus::ir::InstrSeqId, count: &mut usize) {
        for (instr, _) in &func.block(seq).instrs {
            if matches!(instr, Instr::Call(_) | Instr::CallIndirect(_)) {
                *count += 1;
            }
            let children: Vec<walrus::ir::InstrSeqId> = match instr {
                Instr::Block(ir::Block { seq }) | Instr::Loop(ir::Loop { seq }) => vec![*seq],
                Instr::IfElse(ir::IfElse {
                    consequent,
                    alternative,
                }) => vec![*consequent, *alternative],
                Instr::TryTable(ir::TryTable { seq, .. }) => vec![*seq],
                _ => Vec::new(),
            };
            for child in children {
                walk(func, child, count);
            }
        }
    }
    walk(local, local.entry_block(), &mut count);
    count
}

/// Project-level structural ceiling for the old single-leaf cases.
/// The exact engine failure threshold is implementation-dependent; this
/// test pins the shape that downstream work had to avoid with a skip
/// heuristic.
const SAFE_MAX_DEPTH: usize = 64;

/// Two-level / three-level bucketed dispatch ceiling. With
/// `BUCKET_SIZE = 32`, balanced subtrees produce depths {35, 67, 99,
/// 131, …} at N ∈ {32, 1024, 32_768, 1_048_576, …}. The (n+3) leaf
/// constant and the per-level `+M` chain mean the structural minimum
/// for N=1024 is 67 — comfortably under 96 — and N=1025 forces a
/// 3-level tree whose deepest path is 69 with this partition shape.
/// We use 96 as a generous 2x-margin ceiling that still rejects any
/// regression to the linear N-deep shape.
const SAFE_BUCKETED_DEPTH: usize = 96;

/// Independent round-trip validation: parse the instrumented bytes
/// with `wasmparser`'s validator. Catches structural defects (label
/// scope, control-flow stack, br targets) that walrus's own emit
/// path might silently accept. Mirrors the helper in `tests/instrument.rs`.
fn validate(bytes: &[u8]) {
    let mut validator =
        wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default());
    validator
        .validate_all(bytes)
        .expect("instrumented wasm must round-trip through wasmparser");
}

/// Reproduction: instrumenting a direct-call dispatcher with N
/// fork-path calls produces a body whose nesting depth is at least N.
/// Downstream production binaries reported engine/resource failures.
#[test]
fn direct_dispatcher_nesting_depth_scales_with_call_count() {
    for &n in &[8usize, 16, 32, 64, 100] {
        let wat = wat_direct_dispatcher(n);
        let instrumented = instrument_wat(&wat);

        let depth = dispatcher_max_depth(&instrumented);
        assert!(
            depth <= SAFE_MAX_DEPTH,
            "issue #631: dispatcher with {n} fork-path calls produced an \
             instrumented body of depth {depth}, exceeding the project \
             structural ceiling of {SAFE_MAX_DEPTH}. Each additional \
             fork-path call site adds another POST_K block; downstream \
             production binaries with ~1000 such call sites reported \
             `RangeError: Maximum call stack size exceeded`."
        );
    }
}

/// Reproduction (wordpress-playground shape): a `call_indirect`
/// dispatcher whose targets reach `kernel_fork` through the
/// `(table, sig)` indirect closure exhibits the same blow-up.
#[test]
fn indirect_dispatcher_nesting_depth_scales_with_call_count() {
    for &n in &[8usize, 16, 32, 64, 100] {
        let wat = wat_indirect_dispatcher(n);
        let instrumented = instrument_wat(&wat);

        // Sanity-check: the dispatcher actually got instrumented (i.e.
        // it was on the fork-path via the indirect closure).
        let call_count = dispatcher_call_count(&instrumented);
        assert!(
            call_count >= n,
            "expected dispatcher to retain its {n} call sites after \
             instrumentation; saw {call_count}"
        );

        let depth = dispatcher_max_depth(&instrumented);
        assert!(
            depth <= SAFE_MAX_DEPTH,
            "issue #631 (indirect): dispatcher with {n} fork-path \
             call_indirect sites produced an instrumented body of depth \
             {depth}, exceeding the project structural ceiling of \
             {SAFE_MAX_DEPTH}. \
             This is the wordpress-playground reproduction shape — \
             `MAX_FORK_PATH_CALL_SITES` was added downstream as a workaround."
        );
    }
}

/// TDD anchor for the recursive bucketing fix. The cases below are the
/// ones today's linear-nested code can NEVER satisfy: N=1024 currently
/// produces depth=1027, N=1025 depth=1028, etc. After Task 6 lands, the
/// recursive emit caps the depth at `O(M · log_M(N))` ≤ 96 for every N
/// up to ~10⁶, and `wasmparser` accepts the resulting module.
///
/// N=1024 = M² is the largest perfect two-level case (32 buckets × 32
/// calls). N=1025 = M² + 1 is the first three-level case (one outer
/// span of 1024 + a singleton leaf). N=2000 and N=5000 cover
/// non-power-of-M shapes between the two- and three-level boundaries.
///
/// Both the depth bound AND the wasmparser round-trip matter: a fix
/// that lowers depth without preserving validity (e.g. a leaf's UNWIND
/// `br_if` resolving to the wrong block) would silently emit broken
/// wasm. The validator catches that.
#[test]
fn bucketed_depth_direct_dispatcher_passes_v8_limit() {
    for &n in &[1024usize, 1025, 2_000, 5_000] {
        let wat = wat_direct_dispatcher(n);
        let instrumented = instrument_wat(&wat);

        validate(&instrumented);

        let depth = dispatcher_max_depth(&instrumented);
        assert!(
            depth <= SAFE_BUCKETED_DEPTH,
            "issue #631 (bucketed, direct): dispatcher with {n} \
             fork-path calls produced an instrumented body of depth \
             {depth}, exceeding the bucketed ceiling of \
             {SAFE_BUCKETED_DEPTH}. The recursive dispatch should cap \
             depth at O(BUCKET_SIZE · log_BUCKET_SIZE(N)); this depth \
             indicates the linear N-deep shape is still being emitted."
        );
    }
}

/// Same TDD anchor as `bucketed_depth_direct_dispatcher_passes_v8_limit`
/// but for the wordpress-playground `call_indirect` shape. The PHP-FPM
/// dispatcher this models has ~1015 indirect call sites in one function
/// — between the N=1024 and N=1025 boundaries — and is the reason
/// `MAX_FORK_PATH_CALL_SITES` was added downstream.
#[test]
fn bucketed_depth_indirect_dispatcher_passes_v8_limit() {
    for &n in &[1024usize, 1025, 2_000, 5_000] {
        let wat = wat_indirect_dispatcher(n);
        let instrumented = instrument_wat(&wat);

        validate(&instrumented);

        let call_count = dispatcher_call_count(&instrumented);
        assert!(
            call_count >= n,
            "expected dispatcher to retain its {n} call sites after \
             instrumentation; saw {call_count}"
        );

        let depth = dispatcher_max_depth(&instrumented);
        assert!(
            depth <= SAFE_BUCKETED_DEPTH,
            "issue #631 (bucketed, indirect): dispatcher with {n} \
             fork-path call_indirect sites produced an instrumented \
             body of depth {depth}, exceeding the bucketed ceiling of \
             {SAFE_BUCKETED_DEPTH}. The recursive dispatch should cap \
             depth at O(BUCKET_SIZE · log_BUCKET_SIZE(N)); this depth \
             indicates the linear N-deep shape is still being emitted."
        );
    }
}
