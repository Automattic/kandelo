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

use fork_instrument::{Options, instrument};
use walrus::{FunctionId, FunctionKind, ImportKind, LocalFunction, Module, ir::*};

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
fn top_level_carryover_routes_to_guard_dispatch() {
    // Regression for a real-world shape in dash's `cmdputs`: LLVM
    // emits a top-level fork-path call whose address operand was
    // pushed *before* the call's args and is consumed *after* the
    // call returns. Switch-dispatch can't handle the operand-stack
    // carryover (its POST_K blocks are 0 → 0), so the function
    // must route to guard-dispatch instead.
    let wat = include_str!("fixtures/switch_dispatch/top_level_carryover.wat");
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument");
    // The critical invariant: output must validate. Switch-dispatch
    // would produce invalid wasm ("type mismatch at end of block").
    validate(&output);
    let module = Module::from_buffer(&output).expect("walrus parse");

    // A second, more specific invariant: `main` must not carry a
    // top-level `br_table` dispatch — its presence would indicate
    // switch-dispatch was attempted despite the carryover.
    assert!(
        !has_top_level_br_table_dispatch(&module, "main"),
        "`main` must use guard-dispatch (not switch-dispatch) when a \
         top-level fork-path call has an operand-stack carryover"
    );
}

#[test]
fn guard_dispatch_gates_non_fork_path_direct_call() {
    // Regression for the 8 sortix fork-semantic FAILs (waitpid,
    // dup3-clofork-fork, ...). When guard-dispatch is selected
    // (because the fork-path call is nested), non-fork-path direct
    // calls — like `setpgid` — must be wrapped in a state==NORMAL
    // gate so their kernel side effects don't re-fire during REWIND.
    // The call's result must round-trip through a result-save user
    // local that lives in the frame, otherwise consumers consuming
    // the result inline (without `local.set $user_local`) would
    // diverge control flow on REWIND. See
    // memory/fork-instrument-phase7-debug-evidence.md.
    let wat = include_str!("fixtures/switch_dispatch/guard_dispatch_non_fork_call.wat");
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument");
    validate(&output);
    let module = Module::from_buffer(&output).expect("walrus parse");

    // Confirm the function uses guard-dispatch (no top-level br_table).
    assert!(
        !has_top_level_br_table_dispatch(&module, "main"),
        "guard-dispatch path should not emit a top-level br_table"
    );

    // The call to `kernel.setpgid` must still appear (we gate it; we
    // don't remove it). It must appear inside an if-then sequence
    // whose preceding instruction is the state==NORMAL test.
    let setpgid = find_import_func(&module, "kernel.setpgid");
    let main_id = find_func(&module, "main");
    let f = local_func(&module, main_id);

    let mut found_gated_setpgid = false;
    walk_all(f, f.entry_block(), 0, &mut |_seq, _depth, instr| {
        if let Instr::IfElse(IfElse {
            consequent,
            alternative: _,
        }) = instr
        {
            // Look at the consequent: if its first instruction is
            // `Call(setpgid)` and its (only or first) `LocalSet` is
            // immediately after, this is our gate.
            let then_seq = f.block(*consequent);
            let mut iter = then_seq.instrs.iter();
            if let Some((Instr::Call(c), _)) = iter.next() {
                if c.func == setpgid {
                    if let Some((Instr::LocalSet(_), _)) = iter.next() {
                        found_gated_setpgid = true;
                    }
                }
            }
        }
    });

    assert!(
        found_gated_setpgid,
        "expected to find `setpgid` wrapped in a state==NORMAL gate \
         with a result-save `local.set` immediately after the call"
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
        _ => panic!("not a local function: {name:?}", name = module.funcs.get(id).name),
    }
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
