import { readFileSync } from "node:fs";
import createExceptionStore from "./exception_recipe_host.cjs";

const providerModule = new WebAssembly.Module(readFileSync(
  new URL("./provider.wasm", import.meta.url),
));
const transitModule = new WebAssembly.Module(readFileSync(
  new URL("./transit.wasm", import.meta.url),
));
const transit = new WebAssembly.Instance(transitModule).exports.transit;
const wide = process.argv.includes("wide");
const descriptor = new DataView(WebAssembly.Module.customSections(
  providerModule, "kandelo.wpk_fork.gc_codec",
)[0]);
const layouts = new Map();
for (let i = 0; i < descriptor.getUint32(8, true); i++) {
  const offset = 16 + i * 44;
  layouts.set(descriptor.getUint32(offset, true), {
    requiresProvenance: (descriptor.getUint16(offset + 10, true) & 1) !== 0,
    scalarLength: descriptor.getUint32(offset + 36, true),
    referenceCount: descriptor.getUint32(offset + 40, true),
  });
}
const recipes = new Map();
const identities = new WeakMap();
const capturedValues = new Map();
const provenance = new WeakMap();
const brokerValues = new Map();
const vectors = [{ expected: 0, values: [] }];
const exceptions = createExceptionStore();
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
  const memory = new WebAssembly.Memory({ initial: wide ? 2n : 2, address: wide ? "i64" : "i32" });
  const scratch = [];
  let scratchTop = 0x10000;
  let instance;
  const exceptionBinding = exceptions.bind(() => instance, () => memory);

  const implemented = {
    ...exceptionBinding.imports,
    __wpk_fork_ref_encode_funcref(value) {
      if (value === null) return 0;
      if (value !== instance.exports.source_function) throw new Error("unexpected function identity");
      return 1000000;
    },
    __wpk_fork_ref_decode_funcref(recipe) {
      if (recipe === 0) return null;
      if (recipe !== 1000000) throw new Error("invalid function recipe");
      return instance.exports.source_function;
    },
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
        if (!layouts.get(baseLayout).requiresProvenance) return baseLayout;
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
      const layout = layouts.get(specializedLayout);
      if (referenceCount !== layout.referenceCount) throw new Error("wrong provenance seed count");
      const packed = new Uint8Array(16);
      const view = new DataView(packed.buffer);
      view.setBigUint64(0, BigInt.asUintN(64, scalarLo), true);
      view.setBigUint64(8, BigInt.asUintN(64, scalarHi), true);
      const scalars = packed.slice(0, layout.scalarLength);
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
      return wide ? BigInt(address) : address;
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
  return {
    instance, memory,
    assertReleased() {
      if (scratch.length !== 0 || scratchTop !== 0x10000) {
        throw new Error("GC helper retained exchange memory");
      }
      exceptionBinding.assertIdle();
    },
  };
}

const parent = instantiate();
parent.instance.exports.create_cycle();
if (parent.instance.exports.verify_cycle() !== 1) {
  throw new Error("parent fixture did not create its self-cycle");
}
const parentObject = parent.instance.exports.objects.get(0);
transit.set(0, parentObject);
if (parent.instance.exports.__wpk_fork_ref_gc_probe(0) !== 1n) {
  throw new Error("probe lost the exact struct layout");
}
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

parent.instance.exports.create_i31();
transit.set(0, parent.instance.exports.objects.get(5));
if (parent.instance.exports.__wpk_fork_ref_gc_probe(0) !== 0n) {
  throw new Error("i31 must not be mistaken for an aggregate layout");
}
const i31Recipe = parent.instance.exports.__wpk_fork_ref_gc_encode_slot(0);
transit.set(i31Recipe + 1, null);
child.instance.exports.__wpk_fork_ref_gc_allocate(i31Recipe);
child.instance.exports.objects.set(5, transit.get(i31Recipe + 1));
if (child.instance.exports.verify_i31() !== 1) {
  throw new Error("fresh child lost signed i31 payload bits");
}
if (child.instance.exports.__test_decode_externref(0) !== null) {
  throw new Error("null recipe did not decode to null");
}
for (const owner of [parent, child, grandchild, externalizedChild]) {
  owner.assertReleased();
}

// Mutable non-null fields need typed allocation seeds even though their final
// values come from later filling. The exact exception payload points back to
// the containing GC object; the retained constructor seeds differ from the
// final mutable fields.
parent.instance.exports.create_mixed(parentToken);
if (parent.instance.exports.verify_mixed() !== 1
    || parent.instance.exports.verify_mixed_exception() !== 1) {
  throw new Error("parent mixed-reference fixture is invalid");
}
transit.set(0, parent.instance.exports.objects.get(6));
const mixedRecipe = parent.instance.exports.__wpk_fork_ref_gc_encode_slot(0);
const mixedRecord = recipes.get(mixedRecipe);
const mixedVector = vectors[mixedRecord.vector].values;
if (mixedVector[0] !== mixedVector[1] || mixedVector[0] === mixedVector[2]
    || mixedVector[2] !== mixedVector[6]) {
  throw new Error("mixed recipe lost seed aliases or final-field aliases");
}
function materializeMixed(recipe, token) {
  const refs = vectors[recipes.get(recipe).vector].values;
  for (let index = 0; index < transit.length; index++) transit.set(index, null);
  const owner = instantiate();
  owner.instance.exports.__wpk_fork_ref_gc_publish_externref(refs[4], token);
  for (const dependency of new Set([refs[0], refs[2]])) {
    owner.instance.exports.__wpk_fork_ref_gc_allocate(dependency);
    owner.instance.exports.__wpk_fork_ref_gc_fill(dependency);
  }
  owner.instance.exports.__wpk_fork_ref_gc_allocate(recipe);
  owner.instance.exports.__wpk_fork_ref_gc_fill(recipe);
  owner.instance.exports.objects.set(6, transit.get(recipe + 1));
  if (owner.instance.exports.verify_mixed() !== 1
      || owner.instance.exports.verify_mixed_exception() !== 1
      || owner.instance.exports.mixed_token() !== token) {
    throw new Error("fresh child lost typed seeds, exact exception payload, or GC aliases");
  }
  owner.assertReleased();
  return owner;
}
const mixedChild = materializeMixed(mixedRecipe, childToken);
transit.set(0, mixedChild.instance.exports.objects.get(6));
const nestedMixed = mixedChild.instance.exports.__wpk_fork_ref_gc_encode_slot(0);
const nestedRefs = vectors[recipes.get(nestedMixed).vector].values;
if (nestedRefs[0] !== nestedRefs[1] || nestedRefs[0] === nestedRefs[2]) {
  throw new Error("replayed mixed aggregate did not retain its constructor seeds");
}
materializeMixed(nestedMixed, Object.freeze({ owner: "grandchild-token" }));
for (const owner of [parent, mixedChild]) owner.assertReleased();

parent.instance.exports.create_arrays();
if (parent.instance.exports.verify_arrays() !== 1) throw new Error("parent array fixture is invalid");
const arrayRecipes = [];
for (let slot = 7; slot < 18; slot++) {
  transit.set(0, parent.instance.exports.objects.get(slot));
  arrayRecipes.push(parent.instance.exports.__wpk_fork_ref_gc_encode_slot(0));
}
function materializeArrays(roots) {
  for (let index = 0; index < transit.length; index++) transit.set(index, null);
  const owner = instantiate();
  const allocated = new Set();
  for (const [index, root] of roots.entries()) {
    const refs = vectors[recipes.get(root).vector].values;
    // These fixtures' GC dependencies are leaf nodes. Function recipes are
    // resolved by the owning instance's function catalog, outside this map.
    for (const dependency of new Set(refs.filter(id => recipes.has(id)))) {
      if (allocated.has(dependency)) continue;
      owner.instance.exports.__wpk_fork_ref_gc_allocate(dependency);
      owner.instance.exports.__wpk_fork_ref_gc_fill(dependency);
      allocated.add(dependency);
    }
    owner.instance.exports.__wpk_fork_ref_gc_allocate(root);
    owner.instance.exports.__wpk_fork_ref_gc_fill(root);
    owner.instance.exports.objects.set(index + 7, transit.get(root + 1));
  }
  if (owner.instance.exports.verify_arrays() !== 1) {
    throw new Error("fresh child lost packed, scalar, vector or typed-reference array contents");
  }
  owner.assertReleased();
  return owner;
}
const arrayChild = materializeArrays(arrayRecipes);
const nestedArrayRecipes = [];
for (let slot = 7; slot < 18; slot++) {
  transit.set(0, arrayChild.instance.exports.objects.get(slot));
  nestedArrayRecipes.push(arrayChild.instance.exports.__wpk_fork_ref_gc_encode_slot(0));
}
materializeArrays(nestedArrayRecipes);
for (const owner of [parent, arrayChild]) owner.assertReleased();
for (const operation of ["__wpk_fork_ref_gc_allocate", "__wpk_fork_ref_gc_fill"]) {
  let rejected = false;
  try { arrayChild.instance.exports[operation](0x7fffffff); }
  catch (error) { rejected = error instanceof WebAssembly.RuntimeError; }
  if (!rejected) throw new Error(`unknown recipe accepted by ${operation}`);
}
arrayChild.assertReleased();
