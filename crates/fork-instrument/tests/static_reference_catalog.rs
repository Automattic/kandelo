use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use fork_instrument::static_reference_catalog;
use walrus::Module;

fn fixture() -> Vec<u8> {
    wat::parse_str(
        r#"
        (module
          (type $pair (struct (field i32)))
          (global $root (ref $pair)
            (struct.new $pair (i32.const 41)))
          (global $alias (ref $pair)
            (global.get $root))
          (table $values (export "values") 3 3 (ref null $pair))
          (elem $roots (ref $pair)
            (global.get $root)
            (global.get $alias)
            (struct.new $pair (i32.const 99)))

          (func (export "initialize_values")
            i32.const 0
            i32.const 0
            i32.const 3
            table.init $values $roots)

          (func (export "matches_root")
            (param (ref null $pair)) (result i32)
            (local.get 0)
            (global.get $root)
            ref.eq)

          (func (export "matches_table")
            (param i32) (param (ref null $pair)) (result i32)
            (local.get 0)
            (table.get $values)
            (local.get 1)
            ref.eq))
        "#,
    )
    .expect("static-root fixture WAT")
}

fn catalogued_fixture() -> (Vec<u8>, usize) {
    let mut module = Module::from_buffer(&fixture()).expect("parse static-root fixture");
    let plan = static_reference_catalog::plan(&mut module);
    let root_count = plan.root_count();
    static_reference_catalog::inject(&mut module, plan);
    (module.emit_wasm(), root_count)
}

#[test]
fn aliases_keep_one_stable_ordinal_without_hoisting_allocating_elements() {
    let (bytes, root_count) = catalogued_fixture();
    assert_eq!(
        root_count, 2,
        "the immutable global and its global.get aliases share ordinal zero; \
         the independently allocating element owns ordinal one",
    );
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
        .validate_all(&bytes)
        .expect("static-root catalog output validates");

    let module = Module::from_buffer(&bytes).expect("reparse catalogued fixture");
    let catalog = module
        .exports
        .iter()
        .find(|export| export.name == static_reference_catalog::EXPORT)
        .expect("static-root table export");
    let walrus::ExportItem::Table(table) = catalog.item else {
        panic!("static-root catalog export is not a table");
    };
    let table = module.tables.get(table);
    assert_eq!(table.initial, 2);
    assert_eq!(table.maximum, Some(2));
    assert_eq!(table.element_ty, walrus::RefType::ANYREF);
    assert!(
        module
            .exports
            .iter()
            .any(|export| export.name == static_reference_catalog::HARVEST_EXPORT),
        "static-root harvest helper must be exported",
    );

    let allocating_expression = module
        .elements
        .iter()
        .find_map(|element| match &element.items {
            walrus::ElementItems::Expressions(_, expressions) => expressions.get(2),
            _ => None,
        })
        .expect("allocating element expression");
    assert!(
        !matches!(allocating_expression, walrus::ConstExpr::Global(_)),
        "allocating element roots must remain segment-owned rather than being \
         hoisted into a permanent immutable global",
    );
}

#[test]
fn allocating_local_table_initializer_is_harvested_without_hoisting() {
    let input = wat::parse_str(
        r#"
        (module
          (type $pair (struct (field i32)))
          (table $values 2 2 (ref $pair)
            (struct.new $pair (i32.const 73))))
        "#,
    )
    .expect("table-initializer fixture WAT");
    let mut module = Module::from_buffer(&input).expect("parse table-initializer fixture");
    let plan = static_reference_catalog::plan(&mut module);
    assert_eq!(plan.root_count(), 1);

    let table = module.tables.iter().next().expect("source table");
    assert!(
        !matches!(table.init, Some(walrus::ConstExpr::Global(_))),
        "allocating table initializer must not be hoisted into a permanent root",
    );
}

#[test]
fn fresh_instance_catalog_decodes_to_the_identity_observed_by_ref_eq() {
    let (bytes, _) = catalogued_fixture();
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "kandelo-static-reference-catalog-{}-{nonce}",
        std::process::id(),
    ));
    fs::create_dir_all(&dir).expect("create static-root test directory");
    let wasm = dir.join("fixture.wasm");
    let script = dir.join("verify.mjs");
    fs::write(&wasm, bytes).expect("write static-root fixture");
    fs::write(
        &script,
        r#"
import fs from "node:fs";

const module = new WebAssembly.Module(fs.readFileSync(process.argv[2]));
const parent = new WebAssembly.Instance(module);
const child = new WebAssembly.Instance(module);
const parentCatalog = parent.exports.__wpk_fork_static_root_catalog;
const childCatalog = child.exports.__wpk_fork_static_root_catalog;

if (parentCatalog.length !== 2 || childCatalog.length !== 2) {
  throw new Error("unexpected static-root catalog length");
}
for (let index = 0; index < 2; index++) {
  if (parentCatalog.get(index) !== null || childCatalog.get(index) !== null) {
    throw new Error("static-root harvest tables did not instantiate empty");
  }
}
parent.exports.__wpk_fork_static_root_harvest();
child.exports.__wpk_fork_static_root_harvest();
const parentRoot = parentCatalog.get(0);
const childRoot = childCatalog.get(0);
const childElementRoot = childCatalog.get(1);
if (parentRoot === childRoot) {
  throw new Error("fresh instances unexpectedly share a GC object");
}
if (childCatalog.get(0) !== childRoot) {
  throw new Error("repeated anyref table reads did not preserve JS wrapper identity");
}
const transit = new WebAssembly.Table({
  element: "anyref",
  initial: 1,
  maximum: 1,
});
transit.set(0, childRoot);
if (transit.get(0) !== childRoot) {
  throw new Error("anyref table transit did not preserve JS wrapper identity");
}
if (child.exports.matches_root(childRoot) !== 1) {
  throw new Error("child catalog root does not ref.eq its immutable global");
}
if (child.exports.matches_root(transit.get(0)) !== 1) {
  throw new Error("anyref table transit did not preserve Wasm ref.eq identity");
}
parent.exports.initialize_values();
child.exports.initialize_values();
if (child.exports.matches_root(parentRoot) !== 0) {
  throw new Error("parent GC root incorrectly aliases the child's root");
}
if (child.exports.matches_table(0, childRoot) !== 1
    || child.exports.matches_table(1, childRoot) !== 1) {
  throw new Error("global.get element aliases lost their canonical root");
}
if (child.exports.matches_table(2, childElementRoot) !== 1) {
  throw new Error("harvested allocating element does not ref.eq its segment root");
}
for (let index = 0; index < 2; index++) {
  parentCatalog.set(index, null);
  childCatalog.set(index, null);
}
for (let index = 0; index < 2; index++) {
  if (parentCatalog.get(index) !== null || childCatalog.get(index) !== null) {
    throw new Error("static-root harvest tables retained stale GC roots");
  }
}
"#,
    )
    .expect("write static-root verifier");

    let output = Command::new("node")
        .arg(&script)
        .arg(&wasm)
        .output()
        .expect("run Node static-root verifier");
    let _ = fs::remove_dir_all(&dir);
    assert!(
        output.status.success(),
        "Node static-root verifier failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}
