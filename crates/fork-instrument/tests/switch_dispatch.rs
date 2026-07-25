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
         the static call boundary must not need an abort-frame/selector local, \
         saved call_idx and frame_ptr are loaded from the frame header, and \
         unconditional catch metadata locals would raise this count:\n{caller}"
    );
    assert!(
        caller.contains("call $__wpk_fork_select_unwind_frame"),
        "unwind call site must pass its static call index to the shared \
         frame selector before the postamble:\n{caller}"
    );
    let selector = extract_function_text(&printed, "__wpk_fork_select_unwind_frame");
    assert!(
        selector.contains("i32.store offset=4"),
        "the shared frame selector must publish frame.call_index before \
         returning success or synchronous-abort routing:\n{selector}"
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
        "top-level indirect call with a pure table index should need no \
         arg, abort-frame, selector, frame_ptr, or saved-call-index locals:\n{caller}"
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
         static call boundaries do not require an activation-local selector, \
         frame_ptr and saved call_idx must not be declared locals:\n{main}"
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
         no abort-frame or call-selector local is declared, \
         params are not declared locals, and frame_ptr/saved call_idx come from the frame:\n{main}"
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
         arg-spill, condition/carryover, abort-frame, or active-call selector \
         locals:\n{walk}"
    );
    let normalized = walk.lines().map(str::trim).collect::<Vec<_>>().join("\n");
    assert!(
        normalized.contains("local.get 0\ni32.eqz\nglobal.get $_wpk_fork_state"),
        "rewritten IfElse landing should replay the pure eqz(depth) condition \
         before selecting NORMAL vs REWIND:\n{walk}"
    );
    assert!(
        !normalized.contains("local.set 1"),
        "recursive call landing must use its statically known call index rather \
         than adding an activation-local selector:\n{walk}"
    );
    assert!(
        normalized.contains("local.get 0\ni32.const 1\ni32.sub\ncall $walk"),
        "recursive call landing should replay pure depth - 1 argument tail \
         on the lexical branch without allocating an argument local:\n{walk}"
    );
}

#[test]
fn reference_recipe_vector_adds_no_ordinary_activation_local() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))
          (memory (export "memory") 1)
          (func $walk (export "reference_walk")
            (param $depth i32)
            (param $value externref)
            local.get $depth
            i32.eqz
            if
              call $kernel_fork
              drop
              local.get $value
              drop
            else
              local.get $depth
              i32.const 1
              i32.sub
              local.get $value
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
        "activation-owned reference recipes must use the reserved frame word \
         and process vector directly; adding a recipe/vector scratch local \
         would repeat the V8 recursion regression fixed by PR #713. Static \
         call boundaries must not add an abort-frame/selector local either:\n{walk}"
    );
}

#[test]
fn catch_ref_arm_count_does_not_scale_native_local_tuple() {
    fn fixture(arm_count: usize) -> String {
        assert!(arm_count > 0);
        let tags = (0..arm_count)
            .map(|index| format!("(tag $tag{index} (param i32 i64))"))
            .collect::<Vec<_>>()
            .join("\n");
        let catches = (0..arm_count)
            .map(|index| format!("(catch_ref $tag{index} $handler)"))
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            r#"
                (module
                  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))
                  {tags}
                  (memory (export "memory") 1)
                  (func $caller (export "catch_ref_scaling")
                    (block $handler (result i32 i64 exnref)
                      (try_table (result i32 i64 exnref)
                          {catches}
                        call $kernel_fork
                        drop
                        i32.const 17
                        i64.const 23
                        throw $tag0))
                    drop
                    drop
                    drop))
            "#,
        )
    }

    fn counts(arm_count: usize) -> (GeneratedLocalCounts, String) {
        let input = wat::parse_str(fixture(arm_count)).expect("wat parse");
        let output = instrument(&input, &Options::default()).expect("instrument");
        validate(&output);
        let printed = wasmprinter::print_bytes(&output).expect("wasmprinter");
        (
            generated_local_counts(&output, "catch_ref_scaling"),
            extract_function_text(&printed, "caller"),
        )
    }

    let (one_arm, one_arm_wat) = counts(1);
    let (many_arms, many_arms_wat) = counts(32);
    assert_eq!(
        one_arm,
        GeneratedLocalCounts {
            i32: 2,
            i64: 1,
            f32: 0,
            f64: 0,
            v128: 0,
            nullable_exnref: 1,
            other_reference: 0,
            total: 4,
        },
        "one scalar CatchRef arm should need one selector i32, one typed \
         i32/i64 payload union, and one forwarding exnref; the call boundary \
         adds no local:\n{one_arm_wat}",
    );
    assert_eq!(
        many_arms, one_arm,
        "adding scalar CatchRef arms to one mutually-exclusive try_table must \
         not add native activation locals by type:\n{many_arms_wat}",
    );
}

#[test]
fn catch_region_count_does_not_add_control_locals_or_frame_bytes() {
    fn fixture(region_count: usize) -> String {
        assert!(region_count > 0);
        let regions = (0..region_count)
            .map(|index| {
                format!(
                    r#"
                      (block $handler{index}
                        (try_table (catch $tag $handler{index})
                          nop))
                    "#,
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            r#"
                (module
                  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))
                  (tag $tag)
                  (memory (export "memory") 1)
                  (func $caller (export "catch_region_scaling")
                    {regions}
                    call $kernel_fork
                    drop))
            "#,
        )
    }

    fn measure(region_count: usize) -> (GeneratedLocalCounts, Vec<i32>, String) {
        let input = wat::parse_str(fixture(region_count)).expect("wat parse");
        let output = instrument(&input, &Options::default()).expect("instrument");
        validate(&output);
        let printed = wasmprinter::print_bytes(&output).expect("wasmprinter");
        (
            generated_local_counts(&output, "catch_region_scaling"),
            frame_reserve_sizes(&output, "catch_region_scaling"),
            extract_function_text(&printed, "caller"),
        )
    }

    let (one_region, one_frame_sizes, one_region_wat) = measure(1);
    let (many_regions, many_frame_sizes, many_regions_wat) = measure(32);
    assert_eq!(
        one_region,
        GeneratedLocalCounts {
            i32: 1,
            i64: 0,
            f32: 0,
            f64: 0,
            v128: 0,
            nullable_exnref: 0,
            other_reference: 0,
            total: 1,
        },
        "one empty-payload catch region needs only the activation's exact-arm \
         selector; the call boundary adds no local:\n{one_region_wat}",
    );
    assert_eq!(
        many_regions, one_region,
        "static catch-region count must not recreate the old one-i32-per-region \
         marker cost in every native activation:\n{many_regions_wat}",
    );
    assert!(
        one_frame_sizes.iter().all(|size| *size == 16)
            && many_frame_sizes.iter().all(|size| *size == 16),
        "empty-payload catch regions reuse header selector word +8 and must not \
         enlarge a linked activation frame: one={one_frame_sizes:?}, \
         many={many_frame_sizes:?}",
    );
}

#[test]
fn catch_region_count_uses_one_function_wide_operand_union() {
    fn fixture(region_count: usize) -> String {
        assert!(region_count > 0);
        let regions = (0..region_count)
            .map(|index| {
                format!(
                    r#"
                      (block $handler{index} (result i32 i64 exnref)
                        (try_table (result i32 i64 exnref)
                            (catch_ref $tag $handler{index})
                          i32.const {index}
                          i64.const {index}
                          throw $tag))
                      drop
                      drop
                      drop
                    "#,
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            r#"
                (module
                  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))
                  (tag $tag (param i32 i64))
                  (memory (export "memory") 1)
                  (func $caller (export "catch_region_operand_scaling")
                    {regions}
                    call $kernel_fork
                    drop))
            "#,
        )
    }

    fn measure(region_count: usize) -> (GeneratedLocalCounts, Vec<i32>, String) {
        let input = wat::parse_str(fixture(region_count)).expect("wat parse");
        let output = instrument(&input, &Options::default()).expect("instrument");
        validate(&output);
        let printed = wasmprinter::print_bytes(&output).expect("wasmprinter");
        (
            generated_local_counts(&output, "catch_region_operand_scaling"),
            frame_reserve_sizes(&output, "catch_region_operand_scaling"),
            extract_function_text(&printed, "caller"),
        )
    }

    let (one_region, one_frame_sizes, one_region_wat) = measure(1);
    let (many_regions, many_frame_sizes, many_regions_wat) = measure(32);
    assert_eq!(
        one_region,
        GeneratedLocalCounts {
            i32: 2,
            i64: 1,
            f32: 0,
            f64: 0,
            v128: 0,
            nullable_exnref: 1,
            other_reference: 0,
            total: 4,
        },
        "one scalar CatchRef region needs one selector i32, one typed i32/i64 \
         operand union, and one forwarding exnref; the call boundary adds no \
         local:\n{one_region_wat}",
    );
    assert_eq!(
        many_regions, one_region,
        "capture scratch belongs to the dynamically selected catch, so static \
         region count must not add native operand tuples:\n{many_regions_wat}",
    );
    assert!(
        one_frame_sizes.iter().all(|size| *size == 28)
            && many_frame_sizes.iter().all(|size| *size == 28),
        "all regions overlay the same 12-byte scalar catch payload range: \
         one={one_frame_sizes:?}, many={many_frame_sizes:?}",
    );
}

#[test]
fn recipe_backed_catch_arm_count_uses_one_region_local_and_header_only_frame() {
    fn fixture(arm_count: usize) -> String {
        assert!(arm_count > 0);
        let tags = (0..arm_count)
            .map(|index| format!("(tag $tag{index} (param externref))"))
            .collect::<Vec<_>>()
            .join("\n");
        let catches = (0..arm_count)
            .map(|index| format!("(catch_ref $tag{index} $handler)"))
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            r#"
                (module
                  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))
                  {tags}
                  (memory (export "memory") 1)
                  (func $caller (export "catch_ref_recipe_scaling")
                    (block $handler (result externref exnref)
                      (try_table (result externref exnref)
                          {catches}
                        call $kernel_fork
                        drop
                        ref.null extern
                        throw $tag0))
                    drop
                    drop))
            "#,
        )
    }

    fn counts(arm_count: usize) -> (GeneratedLocalCounts, Vec<i32>, String) {
        let input = wat::parse_str(fixture(arm_count)).expect("wat parse");
        let output = instrument(&input, &Options::default()).expect("instrument");
        validate(&output);
        let printed = wasmprinter::print_bytes(&output).expect("wasmprinter");
        (
            generated_local_counts(&output, "catch_ref_recipe_scaling"),
            frame_reserve_sizes(&output, "catch_ref_recipe_scaling"),
            extract_function_text(&printed, "caller"),
        )
    }

    let (one_arm, one_frame_sizes, one_arm_wat) = counts(1);
    let (many_arms, many_frame_sizes, many_arms_wat) = counts(32);
    assert_eq!(
        one_arm,
        GeneratedLocalCounts {
            i32: 1,
            i64: 0,
            f32: 0,
            f64: 0,
            v128: 0,
            nullable_exnref: 1,
            other_reference: 1,
            total: 3,
        },
        "one reference-payload CatchRef arm should need one selector i32, \
         one operand-forwarding externref, and one retained region exnref; \
         the call boundary adds no local:\n{one_arm_wat}",
    );
    assert_eq!(
        many_arms, one_arm,
        "mutually exclusive recipe-backed arms in one try_table must share \
         both their typed operand union and retained exception local:\n\
         {many_arms_wat}",
    );
    assert!(
        one_frame_sizes.iter().all(|size| *size == 16)
            && many_frame_sizes.iter().all(|size| *size == 16),
        "reference-bearing catch payloads belong to the recipe vector; adding \
         static arms must not grow the 16-byte linked-frame payload header: \
         one={one_frame_sizes:?}, many={many_frame_sizes:?}",
    );
}

#[test]
fn recipe_backed_catch_region_count_uses_one_function_local_and_header_only_frame() {
    fn fixture(region_count: usize) -> String {
        assert!(region_count > 0);
        let regions = (0..region_count)
            .map(|index| {
                format!(
                    r#"
                      (block $handler{index} (result externref exnref)
                        (try_table (result externref exnref)
                            (catch_ref $tag $handler{index})
                          ref.null extern
                          throw $tag))
                      drop
                      drop
                    "#,
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            r#"
                (module
                  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))
                  (tag $tag (param externref))
                  (memory (export "memory") 1)
                  (func $caller (export "catch_ref_recipe_region_scaling")
                    {regions}
                    call $kernel_fork
                    drop))
            "#,
        )
    }

    fn measure(region_count: usize) -> (GeneratedLocalCounts, Vec<i32>, String) {
        let input = wat::parse_str(fixture(region_count)).expect("wat parse");
        let output = instrument(&input, &Options::default()).expect("instrument");
        validate(&output);
        let printed = wasmprinter::print_bytes(&output).expect("wasmprinter");
        (
            generated_local_counts(&output, "catch_ref_recipe_region_scaling"),
            frame_reserve_sizes(&output, "catch_ref_recipe_region_scaling"),
            extract_function_text(&printed, "caller"),
        )
    }

    let (one_region, one_frame_sizes, one_region_wat) = measure(1);
    let (many_regions, many_frame_sizes, many_regions_wat) = measure(32);
    assert_eq!(
        one_region,
        GeneratedLocalCounts {
            i32: 1,
            i64: 0,
            f32: 0,
            f64: 0,
            v128: 0,
            nullable_exnref: 1,
            other_reference: 1,
            total: 3,
        },
        "one recipe-backed region should need one selector i32, one shared \
         operand-forwarding externref, and one retained exception; the call \
         boundary adds no local:\n{one_region_wat}",
    );
    assert_eq!(
        many_regions, one_region,
        "the one live catch selector can name only one complete-exception \
         recipe, so 32 static regions must not add 32 native exnref locals:\n\
         {many_regions_wat}",
    );
    assert!(
        one_frame_sizes.iter().all(|size| *size == 16)
            && many_frame_sizes.iter().all(|size| *size == 16),
        "recipe-backed regions must share the process reference vector's one \
         selected exception and must not grow the 16-byte linked frame: \
         one={one_frame_sizes:?}, many={many_frame_sizes:?}",
    );
}

#[test]
fn v128_catch_arm_count_uses_one_region_local_and_header_only_frame() {
    fn fixture(arm_count: usize) -> String {
        assert!(arm_count > 0);
        let tags = (0..arm_count)
            .map(|index| format!("(tag $tag{index} (param v128))"))
            .collect::<Vec<_>>()
            .join("\n");
        let catches = (0..arm_count)
            .map(|index| format!("(catch_ref $tag{index} $handler)"))
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            r#"
                (module
                  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))
                  {tags}
                  (memory (export "memory") 1)
                  (func $caller (export "catch_ref_v128_scaling")
                    (block $handler (result v128 exnref)
                      (try_table (result v128 exnref)
                          {catches}
                        call $kernel_fork
                        drop
                        v128.const i32x4 1 2 3 4
                        throw $tag0))
                    drop
                    drop))
            "#,
        )
    }

    fn counts(arm_count: usize) -> (GeneratedLocalCounts, Vec<i32>, String) {
        let input = wat::parse_str(fixture(arm_count)).expect("wat parse");
        let output = instrument(&input, &Options::default()).expect("instrument");
        validate(&output);
        let printed = wasmprinter::print_bytes(&output).expect("wasmprinter");
        (
            generated_local_counts(&output, "catch_ref_v128_scaling"),
            frame_reserve_sizes(&output, "catch_ref_v128_scaling"),
            extract_function_text(&printed, "caller"),
        )
    }

    let (one_arm, one_frame_sizes, one_arm_wat) = counts(1);
    let (many_arms, many_frame_sizes, many_arms_wat) = counts(32);
    assert_eq!(
        one_arm,
        GeneratedLocalCounts {
            i32: 1,
            i64: 0,
            f32: 0,
            f64: 0,
            v128: 1,
            nullable_exnref: 1,
            other_reference: 0,
            total: 3,
        },
        "one v128-payload CatchRef arm should need one selector i32, \
         one operand-forwarding v128, and one retained region exnref; the \
         call boundary adds no local:\n{one_arm_wat}",
    );
    assert_eq!(
        many_arms, one_arm,
        "mutually exclusive v128 recipe-backed arms in one try_table must \
         share both their typed operand union and retained exception local:\n\
         {many_arms_wat}",
    );
    assert!(
        one_frame_sizes.iter().all(|size| *size == 16)
            && many_frame_sizes.iter().all(|size| *size == 16),
        "v128 catch payloads belong to the complete-exception recipe; adding \
         static arms must not grow the 16-byte linked-frame payload header: \
         one={one_frame_sizes:?}, many={many_frame_sizes:?}",
    );
}

#[test]
fn catch_all_forms_use_one_retained_exception_local_and_no_frame_payload() {
    let fixtures = [
        (
            "catch_all",
            r#"
                (module
                  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))
                  (tag $failure)
                  (memory (export "memory") 1)
                  (func $caller (export "catch_all_recipe_footprint")
                    (block $handler
                      (try_table (catch_all $handler)
                        call $kernel_fork
                        drop
                        throw $failure))))
            "#,
            "catch_all_recipe_footprint",
        ),
        (
            "catch_all_ref",
            r#"
                (module
                  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))
                  (tag $failure)
                  (memory (export "memory") 1)
                  (func $caller (export "catch_all_ref_recipe_footprint")
                    (block $handler (result exnref)
                      (try_table (result exnref) (catch_all_ref $handler)
                        call $kernel_fork
                        drop
                        throw $failure))
                    drop))
            "#,
            "catch_all_ref_recipe_footprint",
        ),
    ];

    for (label, wat, export_name) in fixtures {
        let input = wat::parse_str(wat).unwrap_or_else(|error| panic!("{label}: {error}"));
        let output = instrument(&input, &Options::default())
            .unwrap_or_else(|error| panic!("{label}: {error:#}"));
        validate(&output);
        let printed = wasmprinter::print_bytes(&output).expect("wasmprinter");
        let caller = extract_function_text(&printed, "caller");
        assert_eq!(
            generated_local_counts(&output, export_name),
            GeneratedLocalCounts {
                i32: 1,
                i64: 0,
                f32: 0,
                f64: 0,
                v128: 0,
                nullable_exnref: 1,
                other_reference: 0,
                total: 2,
            },
            "{label}: an untagged catch needs one selector i32 and exactly \
             one retained region exception local; the call boundary adds no \
             local:\n{caller}",
        );
        let frame_sizes = frame_reserve_sizes(&output, export_name);
        assert!(
            frame_sizes.iter().all(|size| *size == 16),
            "{label}: the complete exception belongs to the recipe vector, \
             not additional linked-frame bytes: {frame_sizes:?}",
        );
    }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct GeneratedLocalCounts {
    i32: usize,
    i64: usize,
    f32: usize,
    f64: usize,
    v128: usize,
    nullable_exnref: usize,
    other_reference: usize,
    total: usize,
}

fn generated_local_counts(bytes: &[u8], export_name: &str) -> GeneratedLocalCounts {
    let mut imported_functions = 0u32;
    let mut exported_function = None;
    let mut defined_function = 0u32;
    for payload in wasmparser::Parser::new(0).parse_all(bytes) {
        match payload.expect("parse generated module") {
            wasmparser::Payload::ImportSection(imports) => {
                for import in imports.into_imports() {
                    if matches!(
                        import.expect("parse generated import").ty,
                        wasmparser::TypeRef::Func(_) | wasmparser::TypeRef::FuncExact(_)
                    ) {
                        imported_functions += 1;
                    }
                }
            }
            wasmparser::Payload::ExportSection(exports) => {
                for export in exports {
                    let export = export.expect("parse generated export");
                    if export.name == export_name && export.kind == wasmparser::ExternalKind::Func {
                        exported_function = Some(export.index);
                    }
                }
            }
            wasmparser::Payload::CodeSectionEntry(body) => {
                let function_index = imported_functions + defined_function;
                defined_function += 1;
                if Some(function_index) != exported_function {
                    continue;
                }

                let mut counts = GeneratedLocalCounts {
                    i32: 0,
                    i64: 0,
                    f32: 0,
                    f64: 0,
                    v128: 0,
                    nullable_exnref: 0,
                    other_reference: 0,
                    total: 0,
                };
                for local in body
                    .get_locals_reader()
                    .expect("read generated locals")
                    .into_iter()
                {
                    let (count, ty) = local.expect("parse generated local");
                    let count = count as usize;
                    counts.total += count;
                    match ty {
                        wasmparser::ValType::I32 => counts.i32 += count,
                        wasmparser::ValType::I64 => counts.i64 += count,
                        wasmparser::ValType::F32 => counts.f32 += count,
                        wasmparser::ValType::F64 => counts.f64 += count,
                        wasmparser::ValType::V128 => counts.v128 += count,
                        wasmparser::ValType::Ref(wasmparser::RefType::EXNREF) => {
                            counts.nullable_exnref += count;
                        }
                        wasmparser::ValType::Ref(_) => counts.other_reference += count,
                    }
                }
                return counts;
            }
            _ => {}
        }
    }
    panic!("generated function export `{export_name}` has no code body");
}

fn frame_reserve_sizes(bytes: &[u8], export_name: &str) -> Vec<i32> {
    let module = Module::from_buffer(bytes).expect("parse generated module");
    let frame_select = module
        .funcs
        .iter()
        .find(|function| function.name.as_deref() == Some("__wpk_fork_select_unwind_frame"))
        .expect("generated unwind-frame selector")
        .id();
    let function_id = module
        .exports
        .iter()
        .find_map(|export| {
            (export.name == export_name).then(|| match export.item {
                walrus::ExportItem::Function(function) => Some(function),
                _ => None,
            })?
        })
        .unwrap_or_else(|| panic!("generated function export `{export_name}` not found"));
    let function = local_func(&module, function_id);
    let mut sizes = Vec::new();

    fn collect(
        function: &LocalFunction,
        sequence: InstrSeqId,
        frame_select: FunctionId,
        sizes: &mut Vec<i32>,
    ) {
        let instructions = &function.block(sequence).instrs;
        for (index, (instruction, _)) in instructions.iter().enumerate() {
            if matches!(instruction, Instr::Call(call) if call.func == frame_select) {
                let Some((
                    Instr::Const(Const {
                        value: Value::I32(size),
                    }),
                    _,
                )) = index
                    .checked_sub(2)
                    .and_then(|previous| instructions.get(previous))
                else {
                    panic!(
                        "unwind-frame selector must be preceded by its exact \
                         static size and call index"
                    );
                };
                sizes.push(*size);
            }
            for child in nested_of(instruction) {
                collect(function, child, frame_select, sizes);
            }
        }
    }

    collect(function, function.entry_block(), frame_select, &mut sizes);
    assert!(
        !sizes.is_empty(),
        "generated function export `{export_name}` has no unwind-frame selection"
    );
    sizes
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
