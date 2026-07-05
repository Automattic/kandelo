//! Regression tests for the switch-dispatch redesign.
//!
//! These tests codify the two classes of fork-semantic bug proven in
//! the 2026-04-22 debug session (see
//! `memory/fork-instrument-phase7-debug-evidence.md`):
//!
//! - **waitpid-class**: non-fork-path direct calls must NOT re-fire
//!   during REWINDING.
//! - **posix_spawn-class**: code between call sites must NOT re-execute,
//!   including shadow-stack manipulation.

use fork_instrument::{instrument, Options};
use walrus::{ir::*, FunctionId, FunctionKind, ImportKind, LocalFunction, Module};

fn validate(bytes: &[u8]) {
    let mut validator =
        wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default());
    validator
        .validate_all(bytes)
        .unwrap_or_else(|e| panic!("wasmparser validation failed: {e}"));
}

#[test]
fn waitpid_class_non_fork_path_call_skipped_on_rewind() {
    let wat = include_str!("fixtures/switch_dispatch/waitpid_class.wat");
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument");
    validate(&output);
    let module = Module::from_buffer(&output).expect("walrus parse");

    assert!(
        has_top_level_br_table_dispatch(&module, "main"),
        "`main` must contain a top-level br_table dispatch"
    );
    assert!(
        !call_appears_inside_dispatch_body(&module, "main", "kernel.setpgid"),
        "`kernel.setpgid` must live in chunk 0, outside the dispatch post-landing body"
    );
}

#[test]
fn top_level_carryover_uses_switch_dispatch_with_carryover_spills() {
    // Regression for a real-world shape in dash's `cmdputs`: LLVM
    // emits a top-level fork-path call whose address operand was
    // pushed *before* the call's args and is consumed *after* the
    // call returns.
    //
    // Pre-2.4c (2026-05-13 plan, decided 2026-05-14): switch-
    // dispatch's $POST_K blocks are 0 → 0 and can't express the
    // carryover, so the function routed to guard-dispatch.
    //
    // Post-2.4c: switch-dispatch absorbs the carryover by spilling
    // the carryover values to per-call carryover spill locals after
    // arg-spilling at the call site (Option B of the spilling
    // analysis). Result: switch-dispatch's br_table is now present;
    // the operand stack is clean at the $POST_K boundary because
    // the carryover is in a local rather than on the stack.
    let wat = include_str!("fixtures/switch_dispatch/top_level_carryover.wat");
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument");
    // The critical invariant: output must validate. Both schemes
    // must produce valid wasm.
    validate(&output);
    let module = Module::from_buffer(&output).expect("walrus parse");

    // After 2.4c, switch-dispatch is the routing target for top-level
    // carryover (compute_carryover_types statically types the
    // local.get $sp producer). br_table SHOULD be present.
    assert!(
        has_top_level_br_table_dispatch(&module, "main"),
        "post-2.4c: `main` must use switch-dispatch (carryover spilling) \
         when top-level fork-path call has a statically-trackable \
         operand-stack carryover"
    );
}

#[test]
fn switch_dispatch_skips_non_fork_path_direct_call_on_rewind() {
    // Regression for the 8 sortix fork-semantic FAILs (waitpid,
    // dup3-clofork-fork, ...). Non-fork-path direct calls — like
    // `setpgid` — must NOT re-fire during REWIND, because their
    // kernel side effects are not idempotent.
    //
    // Pre-2.4c (2026-05-13 plan, decided 2026-05-14): top-level
    // carryovers routed to guard-dispatch, which gated setpgid
    // explicitly with a `(state == NORMAL)` if-then wrapper. Test
    // asserted the explicit gate.
    //
    // Post-2.4c: top-level carryovers route to switch-dispatch with
    // carryover spilling. setpgid lives in `chunks[0]` (pre-call
    // code), which becomes the body of `$POST_0`. On REWIND the
    // br_table jumps directly to `$POST_K` (the call being resumed),
    // skipping `chunks[0]` entirely — so setpgid doesn't re-fire.
    // Same correctness invariant via a different mechanism.
    let wat = include_str!("fixtures/switch_dispatch/guard_dispatch_non_fork_call.wat");
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument");
    validate(&output);
    let module = Module::from_buffer(&output).expect("walrus parse");

    // Switch-dispatch IS the routing target now (carryover spilled).
    assert!(
        has_top_level_br_table_dispatch(&module, "main"),
        "post-2.4c: switch-dispatch with carryover spilling should emit \
         a top-level br_table"
    );

    // setpgid must still appear (we don't remove it; we just ensure
    // REWIND skips it via br_table). The call lives in `chunks[0]`,
    // which is executed only during NORMAL flow (the dispatch's
    // br_table targets $POST_K for REWIND, which lands AFTER chunks[0]
    // has already run during the original NORMAL execution).
    let setpgid = find_import_func(&module, "kernel.setpgid");
    let main_id = find_func(&module, "main");
    let f = local_func(&module, main_id);

    let mut found_setpgid_call = false;
    walk_all(f, f.entry_block(), 0, &mut |_seq, _depth, instr| {
        if let Instr::Call(c) = instr {
            if c.func == setpgid {
                found_setpgid_call = true;
            }
        }
    });
    assert!(
        found_setpgid_call,
        "switch-dispatch must preserve the original setpgid call \
         (now in chunks[0], skipped via br_table on REWIND)"
    );

    // The setpgid call must NOT live inside the dispatch body — it
    // belongs to chunks[0], which is the deepest part of the dispatch
    // structure (POST_0's body). This invariant is what
    // `call_appears_inside_dispatch_body` checks.
    assert!(
        !call_appears_inside_dispatch_body(&module, "main", "kernel.setpgid"),
        "setpgid must remain in chunks[0]; the dispatch body skips it on REWIND"
    );
}

#[test]
fn nested_fork_call_uses_per_block_switch_dispatch() {
    // Path A regression: a fork-path call nested inside an `if-then`
    // must use switch-dispatch with per-block dispatch — NOT fall back
    // to guard-dispatch's REWIND body-replay (which has the popen-class
    // divergence bug documented in
    // memory/fork-instrument-O2-bug-investigation.md).
    //
    // Structural invariant: at least one `br_table` is emitted in `main`.
    // Today, guard-dispatch emits zero br_tables; Path A emits at least
    // one (a top-level dispatch and/or a per-block dispatch inside the
    // `if-then`).
    let wat = include_str!("fixtures/switch_dispatch/nested_fork_call.wat");
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument");
    validate(&output);
    let module = Module::from_buffer(&output).expect("walrus parse");

    assert!(
        has_top_level_br_table_dispatch(&module, "main"),
        "nested fork-path call must use switch-dispatch (br_table emitted), \
         not guard-dispatch's body-replay (no br_table). See \
         memory/fork-instrument-O2-bug-investigation.md for why body-replay \
         diverges."
    );
}

#[test]
fn multivalue_params_block_uses_nested_switch_dispatch() {
    // Sub-commit 2.6c regression: a fork-path call inside a Block
    // whose type signature is `(func (param i32 i32) (result i32))`
    // — a multi-value-params Block — must route to nested switch-
    // dispatch. The body's input params are pre-spilled at body
    // entry and reloaded onto POST_0's local stack so chunks[0]
    // (which consumes them) executes correctly.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))
          (type $two_to_one (func (param i32 i32) (result i32)))
          (memory (export "memory") 1)
          (func $main (export "_start") (result i32)
            (local $pid i32)
            i32.const 7
            i32.const 11
            (block $B (type $two_to_one)
              i32.add
              call $kernel_fork
              drop)
            (local.set $pid)
            (local.get $pid)))
    "#;
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument");
    validate(&output);
    let module = Module::from_buffer(&output).expect("walrus parse");

    assert!(
        has_top_level_br_table_dispatch(&module, "main"),
        "multi-value-params block must use nested switch-dispatch \
         (br_table emitted), not guard-dispatch"
    );
}

#[test]
fn direct_call_carryover_in_block_uses_switch_dispatch() {
    // Sub-commit 2.5c regression: a direct fork-path Call inside a
    // nested Block body whose preceding instructions push an i32
    // carryover onto the Block's local stack must now route to
    // nested switch-dispatch — the per-call `carryover_spills` wiring
    // (2.5b) spills the carryover at the call site and reloads it on
    // REWIND. Mirrors `carryover_at_subregion_uses_switch_dispatch`
    // but exercises the DirectCall landing path rather than the
    // SubRegion landing path.
    let wat = include_str!("fixtures/switch_dispatch/direct_call_carryover_in_block.wat");
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument");
    validate(&output);
    let module = Module::from_buffer(&output).expect("walrus parse");

    assert!(
        has_top_level_br_table_dispatch(&module, "main"),
        "direct-call carryover inside a Block body must route to nested \
         switch-dispatch (br_table emitted), not guard-dispatch's body-replay"
    );
}

#[test]
fn carryover_at_subregion_uses_switch_dispatch() {
    // Per-block switch-dispatch's carryover-spilling extension: a
    // sub-region landing whose preceding chunk pushes a 1-i32 carryover
    // is now handled in switch-dispatch instead of falling back to
    // guard-dispatch. This is the LLVM-O2 inlined posix_spawn pattern
    // that previously failed the sortix `posix_spawnattr_setpgroup`
    // test with `waitpid: ECHILD`.
    let wat = include_str!("fixtures/switch_dispatch/carryover_at_subregion.wat");
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument");
    validate(&output);
    let module = Module::from_buffer(&output).expect("walrus parse");

    assert!(
        has_top_level_br_table_dispatch(&module, "main"),
        "carryover-bearing sub-region landing must use switch-dispatch \
         (br_table emitted), not guard-dispatch's body-replay"
    );
}

#[test]
fn posix_spawn_class_shadow_stack_not_duplicated() {
    let wat = include_str!("fixtures/switch_dispatch/posix_spawn_class.wat");
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument");
    validate(&output);
    let module = Module::from_buffer(&output).expect("walrus parse");

    // The fixture contains TWO global.set $__stack_pointer ops in the
    // source (reserve + restore). After transform, both appear once on
    // the NORMAL path — the critical invariant is that no gating/guard
    // shim introduces extra copies.
    let count = count_global_set(&module, "main", "__stack_pointer");
    assert_eq!(
        count, 2,
        "shadow-stack adjustments must appear exactly twice (reserve + restore), \
         not multiplied by a gating wrapper"
    );
}

#[test]
fn no_catch_switch_dispatch_omits_frame_header_state_locals() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))
          (memory (export "memory") 1)
          (func $caller (export "caller") (result i32)
            (local $x i32)
            i32.const 7
            local.set $x
            call $kernel_fork
            local.get $x
            i32.add))
    "#;
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument");
    validate(&output);

    let printed = wasmprinter::print_bytes(&output).expect("wasmprinter");
    let caller = extract_function_text(&printed, "caller");
    let locals = declared_scalar_local_count(&caller);
    assert_eq!(
        locals, 1,
        "no-catch top-level fork path should declare only the original local; \
         call_idx and frame_ptr are loaded from the frame header, and \
         unconditional catch metadata locals would raise this count:\n{caller}"
    );
    assert!(
        caller.contains("i32.store offset=4"),
        "unwind call site must still write frame.call_index before the shared postamble:\n{caller}"
    );
}

#[test]
fn top_level_indirect_switch_dispatch_omits_frame_header_state_locals() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))
          (type $sig (func (result i32)))
          (table 1 funcref)
          (elem (i32.const 0) $leaf)
          (memory (export "memory") 1)
          (func $leaf (type $sig)
            call $kernel_fork)
          (func $caller (export "caller") (result i32)
            i32.const 0
            call_indirect (type $sig)))
    "#;
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument");
    validate(&output);

    let printed = wasmprinter::print_bytes(&output).expect("wasmprinter");
    let caller = extract_function_text(&printed, "caller");
    let locals = declared_scalar_local_count(&caller);
    assert_eq!(
        locals, 0,
        "top-level indirect call with a pure table index should need no arg, \
         frame_ptr, or call_idx locals:\n{caller}"
    );
}

#[test]
fn nested_direct_switch_dispatch_omits_frame_header_state_locals() {
    let wat = include_str!("fixtures/switch_dispatch/nested_fork_call.wat");
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument");
    validate(&output);

    let printed = wasmprinter::print_bytes(&output).expect("wasmprinter");
    let main = extract_function_text(&printed, "main");
    let locals = declared_scalar_local_count(&main);
    assert_eq!(
        locals, 2,
        "nested block dispatch should retain only the two source locals; \
         frame_ptr and call_idx must not be declared locals:\n{main}"
    );
}

#[test]
fn nested_if_else_dispatch_omits_frame_header_state_locals() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))
          (memory (export "memory") 1)
          (func $main (export "_start") (param $which i32) (result i32)
            local.get $which
            if (result i32)
              call $kernel_fork
            else
              call $kernel_fork
            end))
    "#;
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument");
    validate(&output);

    let printed = wasmprinter::print_bytes(&output).expect("wasmprinter");
    let main = extract_function_text(&printed, "main");
    let locals = declared_scalar_local_count(&main);
    assert_eq!(
        locals, 0,
        "nested if/else dispatch should replay a pure condition without cond_swap; \
         params are not declared locals, and frame_ptr/call_idx must be loaded from \
         the frame:\n{main}"
    );
}

#[test]
fn pr701_shape_replays_pure_condition_and_recursive_arg() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))
          (memory (export "memory") 1)
          (func $walk (export "benchmark_walk") (param $depth i32) (result i32)
            local.get $depth
            i32.eqz
            if (result i32)
              i32.const 0
            else
              call $kernel_fork
              drop
              local.get $depth
              i32.const 1
              i32.sub
              call $walk
            end))
    "#;
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument");
    validate(&output);

    let printed = wasmprinter::print_bytes(&output).expect("wasmprinter");
    let walk = extract_function_text(&printed, "walk");
    let locals = declared_scalar_local_count(&walk);
    assert_eq!(
        locals, 0,
        "PR701-shaped pure condition and recursive arg should not allocate \
         arg-spill or condition/carryover locals:\n{walk}"
    );
    assert!(
        walk.contains("local.get 0\n      i32.eqz\n      global.get $_wpk_fork_state"),
        "rewritten IfElse landing should replay the pure eqz(depth) condition \
         before selecting NORMAL vs REWIND:\n{walk}"
    );
    assert!(
        walk.contains("local.get 0\n        i32.const 1\n        i32.sub\n        call $walk"),
        "recursive call landing should replay pure depth - 1 argument tail \
         before the call:\n{walk}"
    );
}

// -- Helper predicates ----------------------------------------------

fn find_func(module: &Module, name: &str) -> FunctionId {
    module
        .funcs
        .iter()
        .find(|f| f.name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("function `{name}` not found"))
        .id()
}

fn local_func(module: &Module, id: FunctionId) -> &LocalFunction {
    match &module.funcs.get(id).kind {
        FunctionKind::Local(l) => l,
        _ => panic!(
            "not a local function: {name:?}",
            name = module.funcs.get(id).name
        ),
    }
}

fn extract_function_text<'a>(printed: &'a str, name: &str) -> String {
    let needle = format!("(func ${name} ");
    let start = printed
        .find(&needle)
        .unwrap_or_else(|| panic!("function ${name} not found in:\n{printed}"));
    let mut depth = 0i32;
    let mut end = start;
    for (i, c) in printed[start..].char_indices() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    end = start + i + 1;
                    break;
                }
            }
            _ => {}
        }
    }
    printed[start..end].to_string()
}

fn declared_scalar_local_count(func_text: &str) -> usize {
    func_text
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim_start();
            trimmed
                .strip_prefix("(local ")
                .and_then(|rest| rest.strip_suffix(')'))
        })
        .map(|rest| {
            rest.split_whitespace()
                .filter(|tok| matches!(*tok, "i32" | "i64" | "f32" | "f64" | "v128"))
                .count()
        })
        .sum()
}

fn find_import_func(module: &Module, qualified: &str) -> FunctionId {
    let (mod_name, field) = qualified.split_once('.').expect("qualified name");
    for imp in module.imports.iter() {
        if imp.module == mod_name && imp.name == field {
            if let ImportKind::Function(id) = imp.kind {
                return id;
            }
        }
    }
    panic!("import `{qualified}` not found");
}

/// Walk every instruction sequence reachable from `seq` (including
/// nested ones), invoking `visit(seq, depth, instr)` for each instr.
fn walk_all<F: FnMut(InstrSeqId, u32, &Instr)>(
    f: &LocalFunction,
    seq: InstrSeqId,
    depth: u32,
    visit: &mut F,
) {
    for (instr, _) in &f.block(seq).instrs {
        visit(seq, depth, instr);
        for child in nested_of(instr) {
            walk_all(f, child, depth + 1, visit);
        }
    }
}

fn nested_of(instr: &Instr) -> Vec<InstrSeqId> {
    match instr {
        Instr::Block(Block { seq }) => vec![*seq],
        Instr::Loop(Loop { seq }) => vec![*seq],
        Instr::IfElse(IfElse {
            consequent,
            alternative,
        }) => vec![*consequent, *alternative],
        Instr::TryTable(TryTable { seq, .. }) => vec![*seq],
        _ => Vec::new(),
    }
}

/// Returns true if the function contains any `br_table` anywhere in
/// its body. Under the switch-dispatch transform every fork-path
/// function with one or more fork-path calls carries exactly one
/// top-level dispatch br_table.
fn has_top_level_br_table_dispatch(module: &Module, func_name: &str) -> bool {
    let id = find_func(module, func_name);
    let f = local_func(module, id);
    let mut found = false;
    walk_all(f, f.entry_block(), 0, &mut |_, _, instr| {
        if matches!(instr, Instr::BrTable(_)) {
            found = true;
        }
    });
    found
}

/// Returns true iff a call to the specified import appears inside the
/// function's dispatch body — the post-landing region where REWIND
/// control lands after `br_table`. Concretely: the innermost POST_0
/// block holds chunk 0 (pre-dispatch, pre-call-0). Any call outside
/// that innermost block but still inside `$unwind_save` sits on some
/// REWIND path.
fn call_appears_inside_dispatch_body(
    module: &Module,
    func_name: &str,
    import_qualified: &str,
) -> bool {
    let func_id = find_func(module, func_name);
    let target = find_import_func(module, import_qualified);
    let f = local_func(module, func_id);

    // Find the innermost POST_K block. Characterize it as the deepest
    // block that either (a) *contains* a br_table dispatch in its
    // initial instrs, or (b) is targeted by that br_table.
    //
    // Heuristic: walk the function and find any sequence that contains
    // a br_table instruction. The block immediately enclosing the
    // br_table is $dispatch_normal; its enclosing block is $POST_0.
    let mut dispatch_normal: Option<InstrSeqId> = None;
    walk_all(f, f.entry_block(), 0, &mut |seq, _, instr| {
        // br_table lives inside the if-then of $dispatch_normal. Its
        // owning seq is that if-then, whose parent is $dispatch_normal.
        // For our purposes, we want the enclosing $POST_0 block — the
        // *grandparent of the br_table's containing seq*.
        //
        // Simpler: the block that contains the $dispatch_normal seq
        // as its first non-trivial child is $POST_0.
        if matches!(instr, Instr::BrTable(_)) && dispatch_normal.is_none() {
            dispatch_normal = Some(seq);
        }
    });

    // Find the block that contains `dispatch_normal` as a direct
    // Block child — that's $POST_0. We locate it by finding, among all
    // seqs, the one that has an Instr::Block pointing to the seq that
    // contains the br_table's if-then.
    //
    // Correction: `dispatch_normal` above is actually the if-then seq
    // of `(if state==REWIND then br_table end)`. The if-then's parent
    // is the `$dispatch_normal` block. $dispatch_normal's parent block
    // is $POST_0.
    let dispatch_if_then = match dispatch_normal {
        Some(s) => s,
        None => return false, // no dispatch at all
    };

    let dispatch_normal_seq = find_parent_containing_ifelse(f, f.entry_block(), dispatch_if_then);
    let post_0_seq = match dispatch_normal_seq {
        Some(ds) => find_parent_containing_block(f, f.entry_block(), ds),
        None => return false,
    };
    let post_0 = match post_0_seq {
        Some(p) => p,
        None => return false,
    };

    // Now: a call to `target` is "inside dispatch body" if it appears
    // anywhere in the function EXCEPT inside `post_0`'s innermost
    // body (chunk 0).
    let mut in_body = false;
    walk_all(f, f.entry_block(), 0, &mut |seq, _, instr| {
        let is_target_call = match instr {
            Instr::Call(c) => c.func == target,
            _ => false,
        };
        if is_target_call && !is_inside(f, post_0, seq) {
            // It could also be outside $unwind_save entirely (e.g. in
            // the entry's preamble postamble — but those are tool-
            // generated, not user calls). Treat any non-post_0 call
            // as "in dispatch body".
            in_body = true;
        }
    });
    in_body
}

/// Find the sequence S such that S contains an `Instr::IfElse` whose
/// consequent equals `target`.
fn find_parent_containing_ifelse(
    f: &LocalFunction,
    seq: InstrSeqId,
    target: InstrSeqId,
) -> Option<InstrSeqId> {
    for (instr, _) in &f.block(seq).instrs {
        if let Instr::IfElse(ie) = instr {
            if ie.consequent == target || ie.alternative == target {
                return Some(seq);
            }
        }
        for child in nested_of(instr) {
            if let Some(v) = find_parent_containing_ifelse(f, child, target) {
                return Some(v);
            }
        }
    }
    None
}

/// Find the sequence S such that S contains an `Instr::Block { seq: target }`.
fn find_parent_containing_block(
    f: &LocalFunction,
    seq: InstrSeqId,
    target: InstrSeqId,
) -> Option<InstrSeqId> {
    for (instr, _) in &f.block(seq).instrs {
        if let Instr::Block(b) = instr {
            if b.seq == target {
                return Some(seq);
            }
        }
        for child in nested_of(instr) {
            if let Some(v) = find_parent_containing_block(f, child, target) {
                return Some(v);
            }
        }
    }
    None
}

/// Is `candidate` the same as `parent` or one of its transitive
/// descendants?
fn is_inside(f: &LocalFunction, parent: InstrSeqId, candidate: InstrSeqId) -> bool {
    if parent == candidate {
        return true;
    }
    for (instr, _) in &f.block(parent).instrs {
        for child in nested_of(instr) {
            if is_inside(f, child, candidate) {
                return true;
            }
        }
    }
    false
}

/// Count the number of `global.set $GLOBAL_NAME` instructions in the
/// named function (recursively over all nested sequences).
fn count_global_set(module: &Module, func_name: &str, global_name: &str) -> usize {
    let id = find_func(module, func_name);
    let f = local_func(module, id);
    // Resolve the global id from its name.
    let global_id = module
        .globals
        .iter()
        .find(|g| g.name.as_deref() == Some(global_name))
        .map(|g| g.id())
        .unwrap_or_else(|| panic!("global `{global_name}` not found"));

    let mut count = 0usize;
    walk_all(f, f.entry_block(), 0, &mut |_, _, instr| {
        if let Instr::GlobalSet(gs) = instr {
            if gs.global == global_id {
                count += 1;
            }
        }
    });
    count
}
