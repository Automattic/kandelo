use crate::{analyze_constants, analyze_origins};
use serde_json::Value;

fn source(extra: &str, body: &str) -> Vec<u8> {
    wat::parse_str(format!(
        r#"(module
      (import "env" "memory" (memory 2 8 shared))
      (global $sp (export "__stack_pointer") (mut i32) (i32.const 131072))
      {extra} (func (param $p i32) (local $x i32) {body}))"#
    ))
    .unwrap()
}
fn sites(extra: &str, body: &str) -> Vec<Value> {
    analyze_constants(&source(extra, body)).unwrap()["constantSites"]
        .as_array()
        .unwrap()
        .clone()
}

#[test]
fn complex_store_value_is_not_confused_with_its_address() {
    let s = sites(
        "",
        "i32.const 64 local.get $p i32.const 4 i32.add i32.store
                       local.get $p i32.const 8 i32.store",
    );
    assert_eq!(s.len(), 1);
    assert_eq!(s[0]["effectiveStart"], 64);
    assert_eq!(s[0]["write"], true);
}
#[test]
fn straight_line_local_constants_survive_calls_but_not_overwrites() {
    let s = sites(
        "(func $noop)",
        "i32.const 128 local.set $x call $noop
      local.get $x i32.load drop local.get $p local.set $x local.get $x i32.load drop",
    );
    assert_eq!(s.len(), 1);
    assert_eq!(s[0]["effectiveStart"], 128);
}
#[test]
fn joins_and_loop_carried_updates_do_not_invent_constants() {
    for body in [
        "i32.const 128 local.set $x local.get $p if i32.const 64 local.set $x end local.get $x i32.load drop",
        "i32.const 128 local.set $x loop local.get $x i32.load drop local.get $x i32.const 4 i32.add local.set $x local.get $p br_if 0 end",
    ] {
        assert!(sites("", body).is_empty());
    }
}
#[test]
fn producer_wrap_and_unsigned_memarg_overflow_are_distinct() {
    let s = sites(
        "",
        "i32.const -1 i32.const 2 i32.add i32.load offset=3 drop
      i32.const 1 i32.load offset=4294967295 drop i32.const -1 i32.load8_u drop",
    );
    assert_eq!(s.len(), 3);
    assert_eq!(s[0]["effectiveStart"], 4);
    assert_eq!(s[0]["validMemory32Range"], true);
    assert_eq!(s[1]["effectiveStart"], 4294967296u64);
    assert_eq!(s[1]["validMemory32Range"], false);
    assert_eq!(s[2]["effectiveEndExclusive"], 4294967296u64);
    assert_eq!(s[2]["validMemory32Range"], true);
}
#[test]
fn atomic_and_simd_operands_keep_operation_and_address_identity() {
    let s = sites(
        "",
        "i32.const 64 i32.const 1 i32.const 2 i32.atomic.rmw.cmpxchg drop
      i32.const 72 v128.const i32x4 0 0 0 0 v128.load32_lane 1 drop",
    );
    assert_eq!(s.len(), 2);
    assert_eq!(s[0]["atomic"], true);
    assert_eq!(s[0]["width"], 4);
    assert_eq!(s[1]["atomic"], false);
    assert_eq!(s[1]["effectiveStart"], 72);
    assert_eq!(s[1]["width"], 4);
}
#[test]
fn initial_data_containment_merges_adjacent_ranges_without_claiming_ownership() {
    let s = sites(
        r#"(data (i32.const 64) "12345678") (data (i32.const 72) "abcdefgh")
      (data (i32.const 65534) "12345678")"#,
        "i32.const 68 i64.load drop i32.const 76 i64.load drop i32.const 65534 i32.load drop",
    );
    assert_eq!(s[0]["initialDataRange"], true);
    assert_eq!(s[1]["initialDataRange"], false);
    assert_eq!(s[2]["initialDataRange"], true);
    assert_eq!(s[2]["singlePage"], false);
}
#[test]
fn globals_loaded_pointers_and_unknown_call_results_remain_unknown() {
    assert!(
        sites(
            "(global $g (mut i32) (i32.const 64)) (func $p (result i32) i32.const 64)",
            "global.get $g i32.load drop call $p i32.load drop local.get $p i32.load i32.load drop"
        )
        .is_empty()
    );
}
#[test]
fn default_analysis_has_no_new_constant_fields() {
    let r = analyze_origins(&source("", "i32.const 64 i32.load drop")).unwrap();
    assert!(r.get("constantSites").is_none() && r.get("constantAnalysis").is_none());
    assert_eq!(r["totals"]["memorySites"], 1);
}

#[test]
fn loop_parameter_initial_constant_is_not_a_loop_invariant() {
    let s = sites(
        "",
        "i32.const 64 loop (param i32) (result i32) local.tee $x i32.load drop i32.const 128 local.get $p br_if 0 end drop",
    );
    assert!(
        s.is_empty(),
        "loop parameter changes on the backedge: {s:?}"
    );
}

#[test]
fn constants_do_not_require_a_c_stack_marker() {
    let bytes = wat::parse_str(
        r#"(module (import "env" "memory" (memory 2 8 shared))
        (func i32.const 64 i32.load drop))"#,
    )
    .unwrap();
    let report = analyze_constants(&bytes).unwrap();
    assert_eq!(report["constantAnalysis"]["version"], 2);
    assert_eq!(report["constantSites"][0]["effectiveStart"], 64);
    assert!(report["stackGlobal"].is_null());
    assert!(analyze_origins(&bytes).is_err());
}

#[test]
fn loop_local_constants_still_require_an_invariant_definition() {
    let s = sites(
        "",
        "i32.const 64 local.set $x loop local.get $x i32.load drop local.get $p br_if 0 end",
    );
    assert_eq!(s.len(), 1);
    assert_eq!(s[0]["effectiveStart"], 64);
    let s = sites(
        "",
        "loop i32.const 128 local.set $x local.get $x i32.load drop local.get $p br_if 0 end",
    );
    assert_eq!(s.len(), 1);
    assert_eq!(s[0]["effectiveStart"], 128);
}
