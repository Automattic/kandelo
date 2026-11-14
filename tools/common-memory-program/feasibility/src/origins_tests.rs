use crate::analyze_origins;
use serde_json::Value;

fn module(functions: &str) -> Vec<u8> {
    wat::parse_str(format!(
        r#"(module
      (import "env" "memory" (memory 2 8 shared))
      (global $sp (export "__stack_pointer") (mut i32) (i32.const 131072))
      (func $noop) {functions})"#
    ))
    .unwrap()
}
fn count(report: &Value, name: &str) -> u64 {
    report["totals"][name].as_u64().unwrap_or(0)
}
fn frame(body: &str) -> Value {
    analyze_origins(&module(&format!(
        r#"(func (export "f") (param $p i32)
       (local $frame i32) (local $alias i32)
       global.get $sp i32.const 32 i32.sub local.tee $frame global.set $sp
       {body})"#
    )))
    .unwrap()
}

#[test]
fn address_operand_is_not_the_complex_store_value() {
    let r = frame("local.get $p i32.const 4 local.get $frame i32.add i32.store");
    assert_eq!(count(&r, "legacyAdjacentFrameSites"), 1);
    assert_eq!(count(&r, "producerAnchorFrameOpportunities"), 0);
    assert_eq!(count(&r, "definitionFrameOrigins"), 0);
}

#[test]
fn computed_addresses_and_complex_i64_values_keep_the_real_address() {
    let r = frame(
        "local.get $frame i32.const 4 i32.add i64.const 5 i64.const 6 i64.add i64.store offset=4
                 local.get $frame i32.const 12 i32.add i32.load drop",
    );
    assert_eq!(count(&r, "legacyAdjacentFrameSites"), 0);
    assert_eq!(count(&r, "producerAnchorFrameOpportunities"), 2);
    assert_eq!(count(&r, "definitionFrameOrigins"), 2);
    assert_eq!(count(&r, "frameOriginsWithoutInterveningEffects"), 1);
}

#[test]
fn aliases_retain_origin_but_an_overwritten_frame_name_is_not_a_proof() {
    let r = frame(
        "local.get $frame i32.const 8 i32.add local.set $alias
                 local.get $alias i32.load drop
                 local.get $p local.set $frame local.get $frame i32.load drop",
    );
    assert_eq!(count(&r, "definitionFrameOrigins"), 1);
    assert_eq!(count(&r, "producerAnchorFrameOpportunities"), 1);
    let sites = r["candidateSites"].as_array().unwrap();
    assert!(
        sites
            .iter()
            .any(|s| s["definitionOrigin"] == true && s["anchorNameOpportunity"] == false)
    );
    assert!(
        sites
            .iter()
            .any(|s| s["definitionOrigin"] == false && s["anchorNameOpportunity"] == true)
    );
}

#[test]
fn unsigned_memarg_is_not_folded_through_a_wrapped_negative_pointer_offset() {
    let r = frame(
        "local.get $frame i32.const -16 i32.add i32.load offset=32 drop
                 local.get $frame i32.load offset=31 drop",
    );
    assert_eq!(count(&r, "definitionFrameOrigins"), 0);
    assert_eq!(count(&r, "producerAnchorFrameOpportunities"), 0);
}

#[test]
fn calls_preserve_virtual_origin_but_end_the_effect_window() {
    let r = frame("local.get $frame i32.load drop call $noop local.get $frame i32.load drop");
    assert_eq!(count(&r, "definitionFrameOrigins"), 2);
    assert_eq!(count(&r, "frameOriginsWithoutInterveningEffects"), 1);
}

#[test]
fn control_joins_do_not_invent_a_local_definition() {
    let r =
        frame("local.get $p if i32.const 0 local.set $frame end local.get $frame i32.load drop");
    assert_eq!(count(&r, "definitionFrameOrigins"), 0);
    assert_eq!(count(&r, "producerAnchorFrameOpportunities"), 1);
}

#[test]
fn vector_lane_and_atomic_cmpxchg_use_the_first_input_as_address() {
    let r = frame(
        "local.get $frame v128.const i32x4 0 0 0 0 v128.load32_lane offset=4 0 drop
                 local.get $frame i32.const 1 i32.const 2 i32.atomic.rmw.cmpxchg drop",
    );
    assert_eq!(count(&r, "definitionFrameOrigins"), 2);
    assert_eq!(count(&r, "atomicMemorySites"), 1);
}

#[test]
fn pure_inner_loop_can_exist_in_a_function_with_calls() {
    let r = analyze_origins(&module(
        r#"(func (export "f") (param $p i32)
      loop $outer call $noop
        loop $inner local.get $p i32.load drop i32.const 0 br_if $inner end
        i32.const 0 br_if $outer end)"#,
    ))
    .unwrap();
    assert_eq!(count(&r, "loops"), 2);
    assert_eq!(count(&r, "readOnlyLoops"), 1);
    assert_eq!(count(&r, "readonlyLoopInvariantSites"), 1);
}

#[test]
fn absolute_addresses_and_large_displacements_are_still_invariant() {
    let r = analyze_origins(&module(
        r#"(func (export "f") (param $p i32)
      loop $l i32.const 100000 i32.load drop
       local.get $p i32.const 100000 i32.add i32.load drop
       i32.const 0 br_if $l end)"#,
    ))
    .unwrap();
    assert_eq!(count(&r, "readonlyLoopInvariantSites"), 2);
}

#[test]
fn pointer_and_index_strides_are_opportunities_with_unproved_bounds() {
    let r = analyze_origins(&module(
        r#"(func (export "f") (param $p i32) (param $end i32)
      loop $l local.get $p i32.load drop
       local.get $p i32.const 4 i32.add local.tee $p local.get $end i32.lt_u br_if $l end)
      (func (export "indexed") (param $p i32) (param $n i32) (local $i i32)
      loop $l local.get $p local.get $i i32.const 2 i32.shl i32.add i32.load drop
       local.get $i i32.const 1 i32.add local.tee $i local.get $n i32.lt_u br_if $l end)"#,
    ))
    .unwrap();
    assert_eq!(count(&r, "readonlyStrideBoundOpportunities"), 2);
    assert_eq!(count(&r, "readonlyLoopInvariantSites"), 0);
    assert!(r["scope"].as_str().unwrap().contains("NOT induction"));
}

#[test]
fn stores_calls_growth_and_atomics_exclude_the_readonly_loop_window() {
    for effect in [
        "local.get $p i32.const 0 i32.store",
        "call $noop",
        "i32.const 0 memory.grow drop",
        "local.get $p i32.atomic.load drop",
    ] {
        let r = analyze_origins(&module(&format!(
            r#"(func (export "f") (param $p i32)
          loop $l local.get $p i32.load drop {effect} i32.const 0 br_if $l end)"#
        )))
        .unwrap();
        assert_eq!(count(&r, "readonlyLoopInvariantSites"), 0, "{effect}");
        assert_eq!(count(&r, "readonlyStrideBoundOpportunities"), 0, "{effect}");
    }
}

#[test]
fn branch_condition_is_after_the_loop_label_arguments() {
    let r = analyze_origins(&module(
        r#"(func (export "f") (param $p i32) (param $n i32) (local $i i32)
      i32.const 0 loop $l (param i32) drop
       local.get $p local.get $i i32.add i32.load drop
       local.get $i i32.const 1 i32.add local.set $i
       i32.const 42 local.get $i local.get $n i32.lt_u br_if $l drop end)"#,
    ))
    .unwrap();
    assert_eq!(r["loops"][0]["strideHints"].as_array().unwrap().len(), 1);
    assert_eq!(r["loops"][0]["entryEmpty"], false);
    assert_eq!(count(&r, "readonlyStrideBoundOpportunities"), 0);
}

#[test]
fn unreachable_polymorphic_stacks_are_accounted_without_fake_origins() {
    let r = analyze_origins(&module(r#"(func (export "f") unreachable i32.load drop)"#)).unwrap();
    assert_eq!(count(&r, "unreachableMemorySites"), 1);
    assert_eq!(count(&r, "definitionFrameOrigins"), 0);
}

#[test]
fn a_saved_operand_does_not_become_the_overwritten_local_value() {
    let r = analyze_origins(&module(
        r#"(func (export "f") (param $p i32)
      local.get $p i32.const 4 local.set $p i32.load drop)"#,
    ))
    .unwrap();
    assert_eq!(count(&r, "staleLocalExpressionSites"), 1);
    assert_eq!(
        r["candidateSites"][0]["expressionUsesCurrentLocalVersions"],
        false
    );
    let r = analyze_origins(&module(
        r#"(func (export "f") (param $p i32)
      local.get $p local.get $p i32.const 4 i32.add local.tee $p i32.add i32.load drop)"#,
    ))
    .unwrap();
    assert_eq!(count(&r, "unclassifiedAddressSites"), 1);
}

#[test]
fn a_computed_pointer_tee_keeps_the_original_index_expression() {
    let r=analyze_origins(&module(r#"(func (export "f") (param $p i32) (param $n i32)
      (local $i i32) (local $temporary i32)
      loop $l local.get $p local.get $i i32.const 2 i32.shl i32.add local.tee $temporary i32.load drop
        local.get $i i32.const 1 i32.add local.tee $i local.get $n i32.lt_u br_if $l end)"#)).unwrap();
    assert_eq!(count(&r, "readonlyStrideBoundOpportunities"), 1);
    let terms = r["candidateSites"][0]["expression"]["terms"]
        .as_object()
        .unwrap();
    assert_eq!(terms.len(), 2);
    assert!(!terms.contains_key("3"));
}

#[test]
fn source_admission_rejects_translated_memory64_and_bad_stack_contracts() {
    let legitimate = module(r#"(func (export "__vm_wait"))"#);
    assert!(analyze_origins(&legitimate).is_ok());
    assert!(
        analyze_origins(&module(
            r#"(global (export "__vm_root") i32 (i32.const 0))"#
        ))
        .is_err()
    );
    let mut marked = legitimate;
    let name = b"kandelo.common-memory.prototype";
    marked.extend([0, (name.len() + 1) as u8, name.len() as u8]);
    marked.extend(name);
    assert!(analyze_origins(&marked).is_err());
    let memory64=wat::parse_str(r#"(module (import "e" "m" (memory i64 1 2)) (global (export "__stack_pointer") (mut i32) (i32.const 0)))"#).unwrap();
    assert!(analyze_origins(&memory64).is_err());
    let bad_stack=wat::parse_str(r#"(module (import "e" "m" (memory 1 2)) (global (export "__stack_pointer") (mut i64) (i64.const 0)))"#).unwrap();
    assert!(analyze_origins(&bad_stack).is_err());
    let bad_module=wat::parse_str(r#"(module (import "e" "m" (memory 1 2)) (global (export "__stack_pointer") (mut i32) (i32.const 0)) (func i32.add drop))"#).unwrap();
    assert!(analyze_origins(&bad_module).is_err());
}
