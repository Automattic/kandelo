use fork_instrument::streaming::*;
use std::{
    collections::{BTreeMap, BTreeSet},
    convert::Infallible,
};
use wasm_encoder::reencode::{Reencode, RoundtripReencoder};

struct Transform {
    state: FrozenStateRewrites,
}
impl Reencode for Transform {
    type Error = Infallible;
}
impl FunctionTransform for Transform {
    fn declarations(&self) -> Option<&FrozenDeclarations> {
        Some(self.state.declarations())
    }
    fn function_ir_limits(&self) -> Option<IrLimits> {
        Some(IrLimits::default())
    }
    fn transform_ir(
        &mut self,
        source: &FunctionIr<'_>,
        limit: usize,
    ) -> anyhow::Result<wasm_encoder::Function> {
        self.state
            .emit_function(source, &mut RoundtripReencoder, limit)
    }
    fn emit_helper(&mut self, helper: u32, limit: usize) -> anyhow::Result<wasm_encoder::Function> {
        self.state.emit_helper(helper, limit)
    }
}

fn hooks(tables: impl IntoIterator<Item = u32>) -> StateHooks {
    StateHooks {
        mutation_begin: 0,
        reconcile: 3,
        tables: tables
            .into_iter()
            .map(|t| (t, TableMarkers { mark: 1, grow: 2 }))
            .collect(),
        data: BTreeMap::new(),
        elements: BTreeMap::new(),
    }
}

fn transform(
    input: &[u8],
    synchronized: BTreeSet<u32>,
    resume: Option<u32>,
    hooks: StateHooks,
) -> Vec<u8> {
    let scan = scan(input).unwrap();
    let discovery = StateRewrites::discover(&scan, synchronized, resume, 1024).unwrap();
    let state = discovery
        .freeze(
            &scan,
            &mut RoundtripReencoder,
            scan.types.as_ref().core_type_count_in_module(),
            scan.functions.len() as u32,
            hooks,
            1024 * 1024,
        )
        .unwrap();
    let count = state.declarations().function_count();
    let mut bytes = Vec::new();
    let report = emit_remapped(
        &scan,
        &mut Transform { state },
        &mut bytes,
        EmitLimits::default(),
    )
    .unwrap();
    assert_eq!(report.helper_functions, count);
    wasmparser::Validator::new_with_features(features())
        .validate_all(&bytes)
        .unwrap();
    bytes
}

const HOOKS: &str = r#"
  (import "h" "begin" (func $begin))
  (import "h" "mark" (func $mark (param i64 i64)))
  (import "h" "grow" (func $grow (param i64 i64)))
  (import "h" "guard" (func $guard))
"#;

#[test]
fn barriers_and_drop_bits_execute_in_non_fork_functions_and_preserve_traps() {
    let input = wat::parse_str(format!(
        r#"(module {HOOKS}
      (type $answer (func (result i32)))
      (memory 1) (data $data "x")
      (table $a 2 2 funcref) (table $b 2 funcref)
      (elem $elem func $answer)
      (global $bits (export "bits") (mut i32) (i32.const 0))
      (func $answer (type $answer) i32.const 9)
      (func (export "work") (result i32)
        i32.const 0 i32.const 0 i32.const 1 table.init $a $elem
        i32.const 1 ref.func $answer table.set $a
        i32.const 0 ref.null func i32.const 0 table.fill $a
        i32.const 0 i32.const 1 i32.const 1 table.copy $b $a
        ref.null func i32.const 1 table.grow $a drop
        i32.const 0 table.get $b drop table.size $a drop
        elem.drop $elem data.drop $data
        i32.const 0 call_indirect $b (type $answer))
      (func (export "tail") (result i32) i32.const 0 return_call_indirect $b (type $answer))
      (func (export "writeTrap") i32.const 99 ref.null func table.set $a)
      (func (export "readTrap") i32.const 99 table.get $a drop)
      (func (export "dropAgain") elem.drop $elem data.drop $data))"#
    ))
    .unwrap();
    let mut state_hooks = hooks([0, 1]);
    state_hooks.data.insert(0, DropBit { global: 0, mask: 2 });
    state_hooks
        .elements
        .insert(0, DropBit { global: 0, mask: 1 });
    let bytes = transform(&input, BTreeSet::from([0, 1]), None, state_hooks.clone());
    assert_eq!(
        bytes,
        transform(&input, BTreeSet::from([0, 1]), None, state_hooks)
    );
    let file = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(file.path(), bytes).unwrap();
    let script = r#"
      const fs=require('fs'), assert=require('assert');
      const events=[];
      const imports={h:{begin:()=>events.push(['begin']), guard:()=>events.push(['guard']),
        mark:(a,b)=>events.push(['mark',String(a),String(b)]),
        grow:(a,b)=>events.push(['grow',String(a),String(b)])}};
      const m=new WebAssembly.Module(fs.readFileSync(process.argv[1]));
      const e=new WebAssembly.Instance(m,imports).exports;
      assert.equal(e.work(),9);
      assert.deepStrictEqual(events,[['begin'],['mark','0','1'],['begin'],['mark','1','1'],
        ['begin'],['mark','0','0'],['begin'],['mark','0','1'],['begin'],
        ['grow','4294967295','1'],['guard'],['guard'],['guard']]);
      assert.equal(e.bits.value,3); e.dropAgain(); assert.equal(e.bits.value,3);
      events.length=0; assert.equal(e.tail(),9); assert.deepStrictEqual(events,[['guard']]);
      events.length=0; assert.throws(()=>e.writeTrap(),WebAssembly.RuntimeError);
      assert.deepStrictEqual(events,[['begin']]);
      events.length=0; assert.throws(()=>e.readTrap(),WebAssembly.RuntimeError);
      assert.deepStrictEqual(events,[['guard']]);
    "#;
    let result = std::process::Command::new("node")
        .arg("-e")
        .arg(script)
        .arg(file.path())
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn typed_and_mixed_width_tables_have_valid_helper_signatures() {
    let input = wat::parse_str(format!(
        r#"(module {HOOKS}
      (type $void (func)) (type $duplicate (func))
      (type $typed (func (param i32) (result i32)))
      (table $wide i64 2 funcref) (table $narrow 2 funcref)
      (table $typedTable 2 (ref null $typed))
      (elem $passive funcref (ref.null func))
      (func (param (ref null $typed))
        i64.const 0 i32.const 0 i32.const 0 table.copy $wide $narrow
        i32.const 0 i64.const 0 i32.const 0 table.copy $narrow $wide
        i64.const 0 i32.const 0 i32.const 0 table.init $wide $passive
        i32.const 0 local.get 0 table.set $typedTable
        i32.const 0 table.get $typedTable drop
        local.get 0 i32.const 1 table.grow $typedTable drop
        i32.const 7 i32.const 0 call_indirect $typedTable (type $typed) drop))"#
    ))
    .unwrap();
    transform(&input, BTreeSet::from([0, 1, 2]), None, hooks([0, 1, 2]));
}

#[test]
fn immutable_resume_dispatch_has_no_consumer_barrier() {
    let input = wat::parse_str(format!(
        r#"(module {HOOKS}
      (table 1 funcref)
      (func (export "read") table.size drop i32.const 0 table.get drop))"#
    ))
    .unwrap();
    let scan = scan(&input).unwrap();
    let discovered = StateRewrites::discover(&scan, BTreeSet::from([0]), Some(0), 0).unwrap();
    assert_eq!(discovered.helper_count(), 0);
    let bytes = transform(&input, BTreeSet::from([0]), Some(0), hooks([]));
    assert_eq!(
        scan.functions.len(),
        fork_instrument::streaming::scan(&bytes)
            .unwrap()
            .functions
            .len()
    );
}

#[test]
fn helper_budget_and_incomplete_marker_plans_fail_before_emission() {
    let input = wat::parse_str(format!(
        r#"(module {HOOKS} (table 1 funcref)
      (func i32.const 0 ref.null func table.set))"#
    ))
    .unwrap();
    let scan = scan(&input).unwrap();
    assert!(StateRewrites::discover(&scan, BTreeSet::new(), None, 0).is_err());
    let plan = StateRewrites::discover(&scan, BTreeSet::new(), None, 1).unwrap();
    assert!(
        plan.freeze(&scan, &mut RoundtripReencoder, 3, 5, hooks([]), 1024)
            .is_err()
    );
}
