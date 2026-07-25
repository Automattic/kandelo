use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use fork_instrument::{module_exception_codec, module_gc_codec, runtime};
use walrus::Module;

fn fixture_module() -> Vec<u8> {
    let input = wat::parse_str(
        r#"
        (module
          (import "env" "memory" (memory 2))
          (type $node
            (struct
              (field (mut i32))
              (field (mut (ref null $node)))
              (field (mut (ref null any)))))
          (type $fixed (array i16))
          (type $data-bytes (array i8))
          (type $nullable-array (array (ref null $node)))
          (table $objects (export "objects") 5 (ref null any))
          (data $bytes "\0b\16\21")

          (func (export "create_cycle")
            (local $node (ref null $node))
            i32.const 77
            ref.null $node
            ref.null any
            struct.new $node
            local.set $node
            local.get $node
            local.get $node
            struct.set $node 1
            i32.const 0
            local.get $node
            table.set $objects)

          (func (export "verify_cycle") (result i32)
            (local $node (ref null $node))
            i32.const 0
            table.get $objects
            ref.cast (ref $node)
            local.set $node
            local.get $node
            ref.as_non_null
            struct.get $node 0
            i32.const 77
            i32.eq
            local.get $node
            ref.as_non_null
            local.get $node
            ref.as_non_null
            struct.get $node 1
            ref.as_non_null
            ref.eq
            i32.and)

          (func (export "create_externalized_cycle")
            (param $token externref)
            (result externref)
            (local $node (ref null $node))
            i32.const 88
            ref.null $node
            local.get $token
            any.convert_extern
            struct.new $node
            local.set $node
            local.get $node
            local.get $node
            struct.set $node 1
            i32.const 1
            local.get $node
            table.set $objects
            local.get $node
            extern.convert_any)

          (func (export "verify_externalized_cycle")
            (param $root externref)
            (result i32)
            (local $node (ref null $node))
            local.get $root
            any.convert_extern
            ref.cast (ref $node)
            local.set $node
            local.get $node
            struct.get $node 0
            i32.const 88
            i32.eq
            local.get $node
            local.get $node
            struct.get $node 1
            ref.as_non_null
            ref.eq
            i32.and)

          (func (export "externalized_cycle_token")
            (param $root externref)
            (result externref)
            local.get $root
            any.convert_extern
            ref.cast (ref $node)
            struct.get $node 2
            extern.convert_any)

          (func (export "create_fixed")
            (local $array (ref null $fixed))
            i32.const 11
            i32.const 22
            array.new_fixed $fixed 2
            local.set $array
            i32.const 2
            local.get $array
            table.set $objects)

          (func (export "verify_fixed") (result i32)
            (local $array (ref null $fixed))
            i32.const 2
            table.get $objects
            ref.cast (ref $fixed)
            local.set $array
            local.get $array
            i32.const 0
            array.get_u $fixed
            i32.const 11
            i32.eq
            local.get $array
            i32.const 1
            array.get_u $fixed
            i32.const 22
            i32.eq
            i32.and)

          (func (export "create_data")
            (local $array (ref null $data-bytes))
            i32.const 0
            i32.const 3
            array.new_data $data-bytes $bytes
            local.set $array
            i32.const 3
            local.get $array
            table.set $objects)

          (func (export "verify_data") (result i32)
            (local $array (ref null $data-bytes))
            i32.const 3
            table.get $objects
            ref.cast (ref $data-bytes)
            local.set $array
            local.get $array
            i32.const 0
            array.get_u $data-bytes
            i32.const 11
            i32.eq
            local.get $array
            i32.const 1
            array.get_u $data-bytes
            i32.const 22
            i32.eq
            i32.and
            local.get $array
            i32.const 2
            array.get_u $data-bytes
            i32.const 33
            i32.eq
            i32.and)

          (func (export "create_nullable_empty")
            (local $array (ref null $nullable-array))
            ref.null $node
            i32.const 0
            array.new $nullable-array
            local.set $array
            i32.const 4
            local.get $array
            table.set $objects)

          (func (export "verify_nullable_empty") (result i32)
            i32.const 4
            table.get $objects
            ref.cast (ref $nullable-array)
            array.len
            i32.eqz))
        "#,
    )
    .expect("GC provider fixture WAT");
    let mut module = Module::from_buffer(&input).expect("GC provider fixture module");
    let memory = module.memories.iter().next().expect("provider memory").id();
    let declared = module_gc_codec::declare(&mut module, memory).expect("declare GC codec");
    module
        .exports
        .add("__test_encode_externref", declared.encode_externref);
    module
        .exports
        .add("__test_decode_externref", declared.decode_externref);
    let exception = module_exception_codec::inject_with_reference_overrides(
        &mut module,
        memory,
        Some((declared.encode_externref, declared.decode_externref)),
        Some((declared.encode_anyref, declared.decode_anyref)),
    )
    .expect("inject exception codec");
    let runtime = runtime::inject_linked_runtime_with_reference_overrides(
        &mut module,
        runtime::ReferenceCodecOverrides {
            funcref: Some((
                exception.references.encode_funcref,
                exception.references.decode_funcref,
            )),
            externref: Some((
                exception.references.encode_externref,
                exception.references.decode_externref,
            )),
            exnref: Some((exception.encode, exception.decode)),
            anyref: Some((declared.encode_anyref, declared.decode_anyref)),
            cleanup: Some(exception.clear),
        },
    );
    module_gc_codec::finish_declaration(&mut module, declared, exception, &runtime)
        .expect("finish GC codec");
    module.emit_wasm()
}

fn transit_provider_module() -> Vec<u8> {
    wat::parse_str(
        r#"
        (module
          (table (export "transit") 64 (ref null any)))
        "#,
    )
    .expect("transit provider WAT")
}

#[test]
fn fresh_node_instance_reconstructs_gc_cycle_and_identity() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "kandelo-module-gc-codec-{}-{nonce}",
        std::process::id(),
    ));
    fs::create_dir(&directory).expect("create fixture directory");
    fs::write(directory.join("provider.wasm"), fixture_module()).expect("write provider");
    fs::write(directory.join("transit.wasm"), transit_provider_module())
        .expect("write transit provider");
    fs::write(
        directory.join("test.mjs"),
        r#"
import { readFileSync } from "node:fs";

const providerModule = new WebAssembly.Module(readFileSync(
  new URL("./provider.wasm", import.meta.url),
));
const transitModule = new WebAssembly.Module(readFileSync(
  new URL("./transit.wasm", import.meta.url),
));
const transit = new WebAssembly.Instance(transitModule).exports.transit;
const recipes = new Map();
const identities = new WeakMap();
const capturedValues = new Map();
const provenance = new WeakMap();
const brokerValues = new Map();
const vectors = [{ expected: 0, values: [] }];
let nextRecipe = 1;
let nextProvenance = 1;
let pendingProvenance = null;

function concatenate(left, right) {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function instantiate() {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const scratch = [];
  let scratchTop = 0x10000;
  let instance;

  const implemented = {
    __wpk_fork_ref_gc_lookup(slot) {
      const value = transit.get(slot);
      return value === null ? 0 : (identities.get(value) ?? 0);
    },
    __wpk_fork_ref_gc_claim(slot) {
      const value = transit.get(slot);
      if (value === null) throw new Error("claim of null GC transit slot");
      let recipe = identities.get(value);
      if (recipe === undefined) {
        recipe = nextRecipe++;
        identities.set(value, recipe);
        capturedValues.set(recipe, value);
      }
      return recipe;
    },
    __wpk_fork_ref_gc_broker_encode(slot) {
      const value = transit.get(slot);
      if (value === null) throw new Error("broker encode received null");
      let recipe = identities.get(value);
      if (recipe === undefined) {
        recipe = nextRecipe++;
        identities.set(value, recipe);
        brokerValues.set(recipe, value);
      }
      while (transit.length <= recipe + 1) transit.grow(1);
      return recipe;
    },
    __wpk_fork_ref_gc_i31(value) {
      const recipe = nextRecipe++;
      recipes.set(recipe, {
        activation: 7,
        type: 0xffffffff,
        layout: 0,
        kind: 0,
        scalars: Uint8Array.of(
          value & 0xff,
          (value >>> 8) & 0xff,
          (value >>> 16) & 0xff,
          (value >>> 24) & 0xff,
        ),
        vector: 0,
      });
      return recipe;
    },
    __wpk_fork_ref_gc_capture_layout(slot, activation, baseLayout) {
      if (activation !== 7) throw new Error("wrong capture activation");
      const record = provenance.get(transit.get(slot));
      if (!record) {
        // Layout 1 is the default-constructible mutable struct used by the
        // cycle fixture. Its field snapshot is a complete reconstruction
        // recipe, so only the immutable-array layouts require constructor
        // provenance.
        if (baseLayout === 1) return baseLayout;
        throw new Error("GC constructor provenance was not registered");
      }
      if (record.activation !== activation) {
        throw new Error("GC constructor provenance has the wrong activation");
      }
      if (record.baseLayout !== baseLayout) {
        throw new Error("GC constructor provenance has the wrong base layout");
      }
      return record.specializedLayout;
    },
    __wpk_fork_ref_gc_provenance_begin(
      slot, activation, baseLayout, specializedLayout,
      scalarLo, scalarHi, referenceCount,
    ) {
      if (pendingProvenance !== null) {
        throw new Error("nested GC provenance registration");
      }
      if (activation !== 7) throw new Error("wrong provenance activation");
      const object = transit.get(slot);
      if (object === null) throw new Error("null GC provenance object");
      let scalars;
      if (scalarLo === 0n && scalarHi === 0n) {
        scalars = new Uint8Array();
      } else {
        // array.new_data(0, 3) must occupy one packed eight-byte record.
        if (scalarLo !== 0x0000000300000000n || scalarHi !== 0n) {
          throw new Error(
            `GC data constructor operands were not packed: ${scalarLo}:${scalarHi}`,
          );
        }
        scalars = new Uint8Array(8);
        new DataView(scalars.buffer).setBigUint64(0, scalarLo, true);
      }
      const token = nextProvenance++;
      pendingProvenance = {
        token,
        object,
        activation,
        baseLayout,
        specializedLayout,
        scalars,
        referenceCount,
        references: [],
      };
      return token;
    },
    __wpk_fork_ref_gc_provenance_ref(token, index, slot) {
      if (
        pendingProvenance === null
        || pendingProvenance.token !== token
        || index !== pendingProvenance.references.length
        || index >= pendingProvenance.referenceCount
      ) {
        throw new Error("invalid GC provenance reference");
      }
      pendingProvenance.references.push(transit.get(slot));
    },
    __wpk_fork_ref_gc_provenance_end(token) {
      if (
        pendingProvenance === null
        || pendingProvenance.token !== token
        || pendingProvenance.references.length
          !== pendingProvenance.referenceCount
      ) {
        throw new Error("incomplete GC provenance registration");
      }
      provenance.set(pendingProvenance.object, {
        activation: pendingProvenance.activation,
        baseLayout: pendingProvenance.baseLayout,
        specializedLayout: pendingProvenance.specializedLayout,
        scalars: pendingProvenance.scalars,
        references: pendingProvenance.references,
      });
      pendingProvenance = null;
    },
    __wpk_fork_ref_gc_define(
      recipe, activation, type, layout, kind,
      scalarPointer, scalarLength, vector,
    ) {
      const refs = vectors[vector];
      if (!refs || refs.values.length !== refs.expected) {
        throw new Error("incomplete capture vector");
      }
      const source = capturedValues.get(recipe);
      const constructor = source === undefined ? undefined : provenance.get(source);
      const snapshot = new Uint8Array(
        memory.buffer,
        Number(scalarPointer),
        scalarLength,
      ).slice();
      const constructorRecipes = constructor?.references.map((reference) => {
        if (reference === null) return 0;
        transit.set(0, reference);
        return instance.exports.__wpk_fork_ref_gc_encode_slot(0);
      }) ?? [];
      const combinedVector = constructorRecipes.length === 0
        ? vector
        : vectors.push({
          expected: constructorRecipes.length + refs.values.length,
          values: [...constructorRecipes, ...refs.values],
        }) - 1;
      recipes.set(recipe, {
        activation,
        type,
        layout,
        kind,
        scalars: concatenate(
          constructor?.scalars ?? new Uint8Array(),
          snapshot,
        ),
        vector: combinedVector,
      });
    },
    __wpk_fork_ref_gc_route(recipe, activation) {
      const value = recipes.get(recipe);
      return value?.activation === activation ? value.layout : -1;
    },
    __wpk_fork_ref_gc_payload_len(recipe, activation, layout) {
      const value = recipes.get(recipe);
      if (!value || value.activation !== activation || value.layout !== layout) {
        throw new Error("GC payload route mismatch");
      }
      return value.scalars.length;
    },
    __wpk_fork_ref_gc_load(
      recipe, activation, type, layout, kind, destination, length,
    ) {
      const value = recipes.get(recipe);
      if (
        !value
        || value.activation !== activation
        || value.type !== (type >>> 0)
        || value.layout !== layout
        || value.kind !== kind
        || value.scalars.length !== length
      ) throw new Error("GC load coordinate mismatch");
      new Uint8Array(memory.buffer, Number(destination), length)
        .set(value.scalars);
      return value.vector;
    },
    __wpk_fork_ref_vector_begin(expected) {
      const ordinal = vectors.length;
      vectors.push({ expected, values: [] });
      return ordinal;
    },
    __wpk_fork_ref_vector_append(ordinal, recipe) {
      const vector = vectors[ordinal];
      if (!vector || vector.values.length >= vector.expected) {
        throw new Error("invalid vector append");
      }
      vector.values.push(recipe);
    },
    __wpk_fork_ref_vector_finish(ordinal) {
      const vector = vectors[ordinal];
      if (!vector || vector.values.length !== vector.expected) {
        throw new Error("incomplete vector finish");
      }
      return ordinal;
    },
    __wpk_fork_ref_vector_get(ordinal, index) {
      const value = vectors[ordinal]?.values[index];
      if (value === undefined) throw new Error("invalid vector lookup");
      return value;
    },
    __wpk_fork_ref_scratch_reserve(size) {
      const aligned = (Number(size) + 15) & ~15;
      const address = scratchTop;
      scratchTop += aligned;
      scratch.push({ address, size: Number(size), aligned });
      new Uint8Array(memory.buffer, address, aligned).fill(0);
      return address;
    },
    __wpk_fork_ref_scratch_release(address, size) {
      const reservation = scratch.pop();
      if (
        !reservation
        || reservation.address !== Number(address)
        || reservation.size !== Number(size)
      ) throw new Error("non-LIFO scratch release");
      new Uint8Array(
        memory.buffer,
        reservation.address,
        reservation.aligned,
      ).fill(0);
      scratchTop = reservation.address;
    },
  };

  const imports = {};
  for (const descriptor of WebAssembly.Module.imports(providerModule)) {
    const namespace = imports[descriptor.module] ??= {};
    if (descriptor.kind === "memory") {
      namespace[descriptor.name] = memory;
    } else if (descriptor.kind === "global") {
      namespace[descriptor.name] = descriptor.name === "__wpk_fork_module_activation"
        ? new WebAssembly.Global({ value: "i32", mutable: false }, 7)
        : new WebAssembly.Global({ value: "i32", mutable: true }, 0);
    } else if (descriptor.kind === "table") {
      namespace[descriptor.name] =
        descriptor.name === "__wpk_fork_ref_gc_transit"
          ? transit
          : new WebAssembly.Table({
              element: "anyfunc",
              initial: 1,
            });
    } else if (descriptor.kind === "tag") {
      namespace[descriptor.name] = new WebAssembly.Tag({ parameters: [] });
    } else if (descriptor.kind === "function") {
      namespace[descriptor.name] = implemented[descriptor.name] ?? (() => {
        throw new Error(`unexpected import call ${descriptor.name}`);
      });
    }
  }
  instance = new WebAssembly.Instance(providerModule, imports);
  return { instance, memory };
}

const parent = instantiate();
parent.instance.exports.create_cycle();
if (parent.instance.exports.verify_cycle() !== 1) {
  throw new Error("parent fixture did not create its self-cycle");
}
const parentObject = parent.instance.exports.objects.get(0);
transit.set(0, parentObject);
const recipe = parent.instance.exports.__wpk_fork_ref_gc_encode_slot(0);
if (recipe !== 1) throw new Error(`unexpected root recipe ${recipe}`);
if (vectors[recipes.get(recipe).vector].values[0] !== recipe) {
  throw new Error("parent recipe did not preserve the self-edge");
}
parent.instance.exports.create_fixed();
parent.instance.exports.create_data();
parent.instance.exports.create_nullable_empty();
if (
  parent.instance.exports.verify_fixed() !== 1
  || parent.instance.exports.verify_data() !== 1
  || parent.instance.exports.verify_nullable_empty() !== 1
) {
  throw new Error("parent immutable-array fixture is invalid");
}
transit.set(0, parent.instance.exports.objects.get(2));
const fixedRecipe =
  parent.instance.exports.__wpk_fork_ref_gc_encode_slot(0);
transit.set(0, parent.instance.exports.objects.get(3));
const dataRecipe =
  parent.instance.exports.__wpk_fork_ref_gc_encode_slot(0);
transit.set(0, parent.instance.exports.objects.get(4));
const nullableEmptyRecipe =
  parent.instance.exports.__wpk_fork_ref_gc_encode_slot(0);

// Remove every parent-owned transit identity before creating the child. Replay
// must allocate a new object in the child's recursive type universe.
for (let index = 0; index < transit.length; index++) transit.set(index, null);
const child = instantiate();
child.instance.exports.__wpk_fork_ref_gc_allocate(recipe);
child.instance.exports.__wpk_fork_ref_gc_fill(recipe);
const childObject = transit.get(recipe + 1);
if (childObject === null || childObject === parentObject) {
  throw new Error("fresh child reused or lost the parent GC identity");
}
child.instance.exports.objects.set(0, childObject);
if (child.instance.exports.verify_cycle() !== 1) {
  throw new Error("fresh child lost scalar data, alias identity, or the cycle");
}
for (const [arrayRecipe, tableIndex] of [
  [fixedRecipe, 2],
  [dataRecipe, 3],
  [nullableEmptyRecipe, 4],
]) {
  child.instance.exports.__wpk_fork_ref_gc_allocate(arrayRecipe);
  child.instance.exports.__wpk_fork_ref_gc_fill(arrayRecipe);
  child.instance.exports.objects.set(
    tableIndex,
    transit.get(arrayRecipe + 1),
  );
}
if (
  child.instance.exports.verify_fixed() !== 1
  || child.instance.exports.verify_data() !== 1
  || child.instance.exports.verify_nullable_empty() !== 1
) {
  throw new Error("fresh child lost immutable-array constructor state");
}

// A replayed child is itself a valid future parent. Encoding its reconstructed
// arrays must use constructor provenance registered by the generated allocate
// helper, not a parent-Worker object or a stale transaction slot.
transit.set(0, child.instance.exports.objects.get(2));
const nestedFixedRecipe =
  child.instance.exports.__wpk_fork_ref_gc_encode_slot(0);
transit.set(0, child.instance.exports.objects.get(3));
const nestedDataRecipe =
  child.instance.exports.__wpk_fork_ref_gc_encode_slot(0);
transit.set(0, child.instance.exports.objects.get(4));
const nestedNullableEmptyRecipe =
  child.instance.exports.__wpk_fork_ref_gc_encode_slot(0);
for (let index = 0; index < transit.length; index++) transit.set(index, null);
const grandchild = instantiate();
for (const [arrayRecipe, tableIndex] of [
  [nestedFixedRecipe, 2],
  [nestedDataRecipe, 3],
  [nestedNullableEmptyRecipe, 4],
]) {
  grandchild.instance.exports.__wpk_fork_ref_gc_allocate(arrayRecipe);
  grandchild.instance.exports.__wpk_fork_ref_gc_fill(arrayRecipe);
  grandchild.instance.exports.objects.set(
    tableIndex,
    transit.get(arrayRecipe + 1),
  );
}
if (
  grandchild.instance.exports.verify_fixed() !== 1
  || grandchild.instance.exports.verify_data() !== 1
  || grandchild.instance.exports.verify_nullable_empty() !== 1
) {
  throw new Error("grandchild lost replay-registered GC constructor state");
}

// `extern.convert_any` is only a view of the same GC identity. Encoding that
// view must recover the typed object rather than assigning it an opaque host
// handle, while the token stored inside the object must become one broker leaf.
const parentToken = Object.freeze({ owner: "parent-token" });
const externalizedRoot =
  parent.instance.exports.create_externalized_cycle(parentToken);
if (
  parent.instance.exports.verify_externalized_cycle(
    externalizedRoot,
  ) !== 1
  || parent.instance.exports.externalized_cycle_token(externalizedRoot)
    !== parentToken
) {
  throw new Error("parent externalized fixture lost its GC/token identity");
}
const externalizedRecipe =
  parent.instance.exports.__test_encode_externref(externalizedRoot);
const externalizedRecord = recipes.get(externalizedRecipe);
if (
  !externalizedRecord
  || vectors[externalizedRecord.vector].values[0] !== externalizedRecipe
) {
  throw new Error("externalized GC recipe did not preserve its self-cycle");
}
const tokenRecipe = vectors[externalizedRecord.vector].values[1];
if (brokerValues.get(tokenRecipe) !== parentToken) {
  throw new Error("opaque token was not captured as the graph's broker leaf");
}
const directTokenRecipe =
  parent.instance.exports.__test_encode_externref(parentToken);
if (directTokenRecipe !== tokenRecipe) {
  throw new Error("externref/anyref token aliases received different recipes");
}
transit.set(0, parent.instance.exports.objects.get(1));
const directAnyRecipe =
  parent.instance.exports.__wpk_fork_ref_gc_encode_slot(0);
if (directAnyRecipe !== externalizedRecipe) {
  throw new Error("externalized/direct anyref aliases received different recipes");
}

for (let index = 0; index < transit.length; index++) transit.set(index, null);
const externalizedChild = instantiate();
const childToken = Object.freeze({ owner: "child-token" });
externalizedChild.instance.exports.__wpk_fork_ref_gc_publish_externref(
  tokenRecipe,
  childToken,
);
externalizedChild.instance.exports.__wpk_fork_ref_gc_allocate(
  externalizedRecipe,
);
externalizedChild.instance.exports.__wpk_fork_ref_gc_fill(
  externalizedRecipe,
);
const childExternalizedRoot =
  externalizedChild.instance.exports.__test_decode_externref(
    externalizedRecipe,
  );
if (
  childExternalizedRoot === externalizedRoot
  || childToken === parentToken
  || externalizedChild.instance.exports.verify_externalized_cycle(
    childExternalizedRoot,
  ) !== 1
  || externalizedChild.instance.exports.externalized_cycle_token(
    childExternalizedRoot,
  ) !== childToken
) {
  throw new Error(
    "fresh child lost externalized GC identity, cycle, or broker token",
  );
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
        "Node fresh-instance GC codec test failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}
