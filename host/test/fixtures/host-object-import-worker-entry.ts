// Test-only process-worker entry: the REAL Node worker entry, plus one plain
// local host import a guest can get a genuine host object from.
//
// No production import hands a guest a raw host `externref` -- that is why a
// fork that holds one is a refused boundary rather than a supported path
// (externref stage E2, docs/fork-reference-support.md). To exercise that
// boundary through a real process Worker, this entry adds two `env` imports to
// the guest's import object, and only for a guest that declares them:
//
//   kandelo_test_host_object(tag: i32) -> externref
//     One frozen JavaScript object per tag: a host object with an identity.
//   kandelo_test_host_object_tag(value: externref) -> i32
//     The tag of the object `value` IS (`===`), or -1 -- how the guest proves
//     it still holds the SAME object after its fork was refused.
//
// It does this by wrapping `WebAssembly.instantiate`, the call the worker uses
// to instantiate the guest, before loading the real entry. Nothing in
// `host/src` knows about these imports; every other part of the process
// Worker is the production one.

const hostObjects = new Map<number, object>();

function hostObject(tag: number): object {
  let value = hostObjects.get(tag);
  if (value === undefined) {
    value = Object.freeze({ kandeloTestHostObject: tag });
    hostObjects.set(tag, value);
  }
  return value;
}

function hostObjectTag(value: unknown): number {
  for (const [tag, object] of hostObjects) {
    if (object === value) return tag;
  }
  return -1;
}

const TEST_IMPORTS: Record<string, (...args: never[]) => unknown> = {
  kandelo_test_host_object: hostObject,
  kandelo_test_host_object_tag: hostObjectTag,
};

const instantiate = WebAssembly.instantiate.bind(WebAssembly) as (
  source: WebAssembly.Module,
  imports?: WebAssembly.Imports,
) => Promise<WebAssembly.Instance>;

(WebAssembly as { instantiate: unknown }).instantiate = (
  source: unknown,
  imports?: WebAssembly.Imports,
) => {
  if (
    source instanceof WebAssembly.Module &&
    WebAssembly.Module.imports(source).some(
      (entry) => entry.module === "env" && entry.name in TEST_IMPORTS,
    )
  ) {
    imports = {
      ...(imports ?? {}),
      env: { ...(imports?.env ?? {}), ...TEST_IMPORTS },
    };
  }
  return instantiate(source as WebAssembly.Module, imports);
};

await import("../../src/worker-entry");
