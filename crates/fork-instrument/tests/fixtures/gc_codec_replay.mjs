import { readFileSync } from "node:fs";
import createGcStore from "./gc_recipe_host.mjs";

const providerModule = new WebAssembly.Module(readFileSync(
  new URL("./provider.wasm", import.meta.url),
));
const transitModule = new WebAssembly.Module(readFileSync(
  new URL("./transit.wasm", import.meta.url),
));
const transit = new WebAssembly.Instance(transitModule).exports.transit;
const wide = process.argv.includes("wide");
const { recipes, vectors, brokerValues, instantiate } = createGcStore(providerModule, transit, wide);

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
