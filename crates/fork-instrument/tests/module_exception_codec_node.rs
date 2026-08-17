use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use fork_instrument::module_exception_codec;
use walrus::Module;

fn fixture_module() -> Vec<u8> {
    let input = wat::parse_str(
        r#"
        (module
          (import "env" "memory" (memory 2))
          (tag $test (export "test_tag") (param i32 i64))
          (tag $inner (export "inner_tag") (param i32))
          (tag $outer (export "outer_tag") (param (ref null exn))))
        "#,
    )
    .expect("provider fixture WAT");
    let mut module = Module::from_buffer(&input).expect("provider fixture module");
    let memory = module.memories.iter().next().expect("provider memory").id();
    module_exception_codec::inject(&mut module, memory).expect("inject exception codec");
    module.emit_wasm()
}

fn helper_module() -> Vec<u8> {
    wat::parse_str(
        r#"
        (module
          (import "provider" "tag" (tag $test (param i32 i64)))
          (import "provider" "inner_tag" (tag $inner (param i32)))
          (import "provider" "outer_tag"
            (tag $outer (param (ref null exn))))
          (import "provider" "encode"
            (func $encode (param (ref null exn)) (result i32)))
          (import "provider" "decode"
            (func $decode (param i32) (result (ref null exn))))

          (func (export "capture") (param i32 i64) (result i32)
            (local $exception (ref null exn))
            (block $caught (result i32 i64 (ref exn))
              (try_table (catch_ref $test $caught)
                (local.get 0)
                (local.get 1)
                (throw $test))
              unreachable)
            (local.set $exception)
            drop
            drop
            (local.get $exception)
            (call $encode))

          (func (export "payload_i32") (param i32) (result i32)
            (block $caught (result i32 i64)
              (try_table (catch $test $caught)
                (local.get 0)
                (call $decode)
                (ref.as_non_null)
                (throw_ref))
              unreachable)
            drop)

          (func (export "payload_i64") (param i32) (result i64)
            (local $value i64)
            (block $caught (result i32 i64)
              (try_table (catch $test $caught)
                (local.get 0)
                (call $decode)
                (ref.as_non_null)
                (throw_ref))
              unreachable)
            (local.set $value)
            drop
            (local.get $value))

          (func (export "throw_decoded") (param i32)
            (local.get 0)
            (call $decode)
            (ref.as_non_null)
            (throw_ref))

          (func (export "capture_nested") (param i32) (result i32)
            (local $inner_exception (ref null exn))
            (local $outer_exception (ref null exn))
            (block $caught_inner (result i32 (ref exn))
              (try_table (catch_ref $inner $caught_inner)
                (local.get 0)
                (throw $inner))
              unreachable)
            (local.set $inner_exception)
            drop
            (block $caught_outer (result (ref null exn) (ref exn))
              (try_table (catch_ref $outer $caught_outer)
                (local.get $inner_exception)
                (throw $outer))
              unreachable)
            (local.set $outer_exception)
            drop
            (local.get $outer_exception)
            (call $encode))

          (func (export "nested_payload") (param i32) (result i32)
            (block $caught_inner (result i32)
              (try_table (catch $inner $caught_inner)
                (block $caught_outer (result (ref null exn))
                  (try_table (catch $outer $caught_outer)
                    (local.get 0)
                    (call $decode)
                    (ref.as_non_null)
                    (throw_ref))
                  unreachable)
                (ref.as_non_null)
                (throw_ref))
              unreachable)))
        "#,
    )
    .expect("consumer helper WAT")
}

fn anyref_dependencies() -> Vec<u8> {
    wat::parse_str(
        r#"
        (module
          (func (export "encode") (param (ref null any)) (result i32)
            unreachable)
          (func (export "decode") (param i32) (result (ref null any))
            unreachable))
        "#,
    )
    .expect("anyref dependency WAT")
}

#[test]
fn fresh_node_instance_reconstructs_exact_tag_and_alias_identity() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "kandelo-module-exception-codec-{}-{nonce}",
        std::process::id(),
    ));
    fs::create_dir(&directory).expect("create fixture directory");
    fs::write(directory.join("provider.wasm"), fixture_module()).expect("write provider");
    fs::write(directory.join("helper.wasm"), helper_module()).expect("write helper");
    fs::write(directory.join("anyref.wasm"), anyref_dependencies()).expect("write anyref");
    fs::write(
        directory.join("test.mjs"),
        r#"
import { readFileSync } from "node:fs";

const providerModule = new WebAssembly.Module(readFileSync(
  new URL("./provider.wasm", import.meta.url),
));
const helperModule = new WebAssembly.Module(readFileSync(
  new URL("./helper.wasm", import.meta.url),
));
const anyrefModule = new WebAssembly.Module(readFileSync(
  new URL("./anyref.wasm", import.meta.url),
));
const anyrefs = new WebAssembly.Instance(anyrefModule).exports;
const recipes = new Map();
let nextRecipe = 1;

function instantiate(memory) {
  let provider;
  const ids = new WeakMap();
  const scratch = [];
  let scratchTop = 0x10000;
  const thrown = (slot) => {
    try {
      provider.exports.__wpk_fork_ref_exn_throw_slot(slot);
    } catch (value) {
      return value;
    }
    throw new Error("exception scratch slot returned");
  };
  const imports = {
    env: {
      memory,
      __wpk_fork_module_activation:
        new WebAssembly.Global({ value: "i32", mutable: false }, 0),
      __wpk_fork_ref_exn_lookup(slot) {
        return ids.get(thrown(slot)) ?? 0;
      },
      __wpk_fork_ref_exn_claim(slot) {
        const value = thrown(slot);
        let id = ids.get(value);
        if (id === undefined) {
          id = nextRecipe++;
          ids.set(value, id);
        }
        return id;
      },
      __wpk_fork_ref_exn_define(
        id, activation, tag, layout,
        scalarPointer, scalarLength, refsPointer, refCount,
      ) {
        recipes.set(id, {
          activation, tag, layout,
          scalars: new Uint8Array(
            memory.buffer,
            scalarPointer,
            scalarLength,
          ).slice(),
          refs: new Uint32Array(
            memory.buffer,
            refsPointer,
            refCount,
          ).slice(),
        });
      },
      __wpk_fork_ref_exn_load(
        id, activation, tag, layout,
        scalarPointer, scalarLength, refsPointer, refCount,
      ) {
        const recipe = recipes.get(id);
        if (
          !recipe
          || recipe.activation !== activation
          || recipe.tag !== tag
          || recipe.layout !== layout
          || recipe.scalars.length !== scalarLength
          || recipe.refs.length !== refCount
        ) return 0;
        new Uint8Array(memory.buffer, scalarPointer, scalarLength)
          .set(recipe.scalars);
        new Uint32Array(memory.buffer, refsPointer, refCount)
          .set(recipe.refs);
        return 1;
      },
      __wpk_fork_ref_exn_route(id, activation) {
        const recipe = recipes.get(id);
        return recipe?.activation === activation ? recipe.layout : -1;
      },
      __wpk_fork_ref_exn_cache_index(id) {
        return id;
      },
      __wpk_fork_ref_exn_broker_encode() {
        throw new Error("known local tag unexpectedly reached broker encode");
      },
      __wpk_fork_ref_exn_broker_throw_recipe() {
        throw new Error("known local tag unexpectedly reached broker decode");
      },
      __wpk_fork_ref_exn_ingress_throw() {
        throw new Error("known local tag unexpectedly used ingress");
      },
      __wpk_fork_ref_scratch_reserve(size) {
        const aligned = (size + 15) & ~15;
        const address = scratchTop;
        scratchTop += aligned;
        scratch.push({ address, size, aligned });
        new Uint8Array(memory.buffer, address, aligned).fill(0);
        return address;
      },
      __wpk_fork_ref_scratch_release(address, size) {
        const reservation = scratch.pop();
        if (
          !reservation
          || reservation.address !== address
          || reservation.size !== size
        ) throw new Error("non-LIFO scratch release");
        new Uint8Array(memory.buffer, address, reservation.aligned).fill(0);
        scratchTop = address;
      },
      __wpk_fork_ref_encode_funcref() { throw new Error("unused funcref"); },
      __wpk_fork_ref_decode_funcref() { throw new Error("unused funcref"); },
      __wpk_fork_ref_encode_externref() { throw new Error("unused externref"); },
      __wpk_fork_ref_decode_externref() { throw new Error("unused externref"); },
      __wpk_fork_ref_encode_anyref: anyrefs.encode,
      __wpk_fork_ref_decode_anyref: anyrefs.decode,
    },
  };
  provider = new WebAssembly.Instance(providerModule, imports);
  const helper = new WebAssembly.Instance(helperModule, {
    provider: {
      tag: provider.exports.test_tag,
      inner_tag: provider.exports.inner_tag,
      outer_tag: provider.exports.outer_tag,
      encode: provider.exports.__wpk_fork_ref_encode_exnref,
      decode: provider.exports.__wpk_fork_ref_decode_exnref,
    },
  });
  return { provider, helper };
}

const parent = instantiate(new WebAssembly.Memory({ initial: 2 }));
const recipe = parent.helper.exports.capture(0x78563412, 0x102030405060708n);
if (recipe !== 1) throw new Error(`unexpected recipe ${recipe}`);
const nestedRecipe = parent.helper.exports.capture_nested(0x1234abcd);

// This is a genuinely fresh provider instance with a different local Tag.
const child = instantiate(new WebAssembly.Memory({ initial: 2 }));
if (child.provider.exports.test_tag === parent.provider.exports.test_tag) {
  throw new Error("fresh module unexpectedly reused local tag identity");
}
if (child.helper.exports.payload_i32(recipe) !== 0x78563412) {
  throw new Error("child lost i32 exception payload bits");
}
if (child.helper.exports.payload_i64(recipe) !== 0x102030405060708n) {
  throw new Error("child lost i64 exception payload bits");
}
const catchDecoded = () => {
  try {
    child.helper.exports.throw_decoded(recipe);
  } catch (value) {
    return value;
  }
  throw new Error("decoded exception returned without throwing");
};
if (catchDecoded() !== catchDecoded()) {
  throw new Error("child did not cache reconstructed exnref identity");
}
if (child.helper.exports.nested_payload(nestedRecipe) !== 0x1234abcd) {
  throw new Error("child lost recursively encoded exnref payload");
}
"#,
    )
    .expect("write Node test");

    let output = Command::new("node")
        .arg(directory.join("test.mjs"))
        .output()
        .expect("run Node");
    let _ = fs::remove_dir_all(&directory);
    assert!(
        output.status.success(),
        "Node fresh-instance codec test failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}
