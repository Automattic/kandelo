
import { readFileSync } from "node:fs";
import createExceptionStore from "./exception_recipe_host.cjs";

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
const memoryModule = new WebAssembly.Module(readFileSync(
  new URL("./memory.wasm", import.meta.url),
));
const newMemory = () => new WebAssembly.Instance(memoryModule).exports.memory;
const store = createExceptionStore();
const ingress = store.ingress;

function instantiate(memory) {
  let provider;
  const host = store.bind(() => provider, () => memory);
  const imports = {
    env: {
      memory, ...host.imports,
      __wpk_fork_ref_encode_anyref: anyrefs.encode,
      __wpk_fork_ref_decode_anyref: anyrefs.decode,
    },
  };
  for (const entry of WebAssembly.Module.imports(providerModule)) {
    const namespace = imports[entry.module] ??= {};
    if (entry.name in namespace) continue;
    if (entry.kind === 'function') {
      namespace[entry.name] = () => { throw new Error(`Unexpected runtime call ${entry.name}`); };
    } else if (entry.kind === 'table') {
      namespace[entry.name] = new WebAssembly.Table({ element: 'anyfunc', initial: 1 });
    } else if (entry.kind === 'tag') {
      namespace[entry.name] = new WebAssembly.Tag({ parameters: [] });
    } else throw new Error(`Unexpected import ${entry.name}`);
  }
  provider = new WebAssembly.Instance(providerModule, imports);
  const helper = new WebAssembly.Instance(helperModule, {
    provider: {
      tag: provider.exports.test_tag,
      inner_tag: provider.exports.inner_tag,
      vector_tag: provider.exports.vector_tag,
      outer_tag: provider.exports.outer_tag,
      encode: provider.exports.__wpk_fork_ref_encode_exnref,
      decode: provider.exports.__wpk_fork_ref_decode_exnref,
    },
  });
  return { provider, helper, host };
}

const parent = instantiate(newMemory());
const recipe = parent.helper.exports.capture(0x78563412, 0x102030405060708n);
if (recipe !== 1) throw new Error(`unexpected recipe ${recipe}`);
const nestedRecipe = parent.helper.exports.capture_nested(0x1234abcd);
const vectorRecipe = parent.helper.exports.capture_vector();
const rawValue = { message: 'unknown broker-owned exception' };
ingress.set(7, rawValue);
const brokerRecipe = parent.provider.exports.__wpk_fork_ref_exn_encode_ingress(7);

// This is a genuinely fresh provider instance with a different local Tag.
const child = instantiate(newMemory());
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
if (child.helper.exports.vector_high(vectorRecipe) !== 0x1122334455667788n) {
  throw new Error("child lost vector payload bits");
}
let brokerValue;
try {
  child.provider.exports.__wpk_fork_ref_exn_throw_recipe(brokerRecipe);
} catch (value) { brokerValue = value; }
if (brokerValue !== rawValue) throw new Error("broker-owned value lost its identity");
child.provider.exports.__wpk_fork_exception_materialize(0);
for (const invalid of [-1, 0x7fffffff]) {
  let trapped = false;
  try { child.provider.exports.__wpk_fork_exception_materialize(invalid); }
  catch (error) { trapped = error instanceof WebAssembly.RuntimeError; }
  if (!trapped) throw new Error("invalid recipe did not trap");
}
for (const cleanup of ['__wpk_fork_ref_exn_clear', '__wpk_fork_ref_exn_abort']) {
  const before = catchDecoded();
  child.provider.exports[cleanup]();
  const after = catchDecoded();
  if (before === after) throw new Error("cleanup retained the old exception cache");
  if (!after.is(child.provider.exports.test_tag)) throw new Error("cleanup changed the local tag");
}

parent.host.assertIdle();
child.host.assertIdle();
