import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";

/**
 * Seeding an activation's imported-global (KFIG) custom section.
 *
 * The module needs it to build the imported-global bindings a child reads: the
 * section says which globals an activation imports and at what type, which is
 * half of every binding. It is seeded rather than read because a custom section
 * lives in the `WebAssembly.Module` and only the host can get it out --
 * `WebAssembly.Module.customSections`. The module cannot reach its guests'
 * modules at all.
 */

const EINVAL = 22;

/** A valid, empty KFIG section: 16-byte header, zero records. */
function emptySection(): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4b, 0x46, 0x49, 0x47], 0); // "KFIG"
  view.setUint16(4, 1, true); // version
  view.setUint16(6, 16, true); // header size
  view.setUint32(8, 0, true); // record count
  view.setUint32(12, 0, true); // reserved
  return bytes;
}

function fixture() {
  const memory = new WebAssembly.Memory({
    initial: 256,
    maximum: 16384,
    shared: true,
  });
  const fm = instantiateForkModule({
    module: new WebAssembly.Module(readFileSync(resolveBinary("fork_module32.wasm"))),
    memory,
    ptrWidth: 4,
    reserve: () => 8 * 1024 * 1024,
    label: "kfig seed",
  });
  const x = fm.exports as Record<string, unknown>;
  (x.fm_set_format as (pw: number, prefix: number) => void)(4, 0);
  return {
    memory,
    errno: () => (x.fm_last_errno as () => number)(),
    seed: x.fm_set_activation_imported_globals as (
      a: number,
      p: number,
      n: number,
    ) => void,
    provenance: x.fm_set_imported_global_provenance as (
      consumerActivation: number,
      consumerOwner: number,
      kind: number,
      sourceActivation: number,
      sourceOwner: number,
      rawBits: bigint,
    ) => void,
  };
}

/** Put `bytes` in guest memory at `at` and return the address. */
function place(memory: WebAssembly.Memory, at: number, bytes: Uint8Array): number {
  new Uint8Array(memory.buffer, at, bytes.length).set(bytes);
  return at;
}

describe("imported-global section seeding", () => {
  it("accepts one section per activation", () => {
    const f = fixture();
    const section = emptySection();
    f.seed(0, place(f.memory, 4096, section), section.length);
    expect(f.errno()).toBe(0);
    f.seed(1, place(f.memory, 8192, section), section.length);
    expect(f.errno()).toBe(0);
  });

  it("refuses a malformed section at the SEED, not at the capture", () => {
    // A bad section is the host's bug. Discovering it when the capture finally
    // reads it means discovering it mid-fork, where a truthful errno has
    // already become a trap.
    const f = fixture();
    const bad = emptySection();
    bad[0] = 0x00; // wrong magic
    f.seed(0, place(f.memory, 4096, bad), bad.length);
    expect(f.errno()).toBe(EINVAL);
  });

  it("refuses a second section for an activation it already knows", () => {
    // Two sections for one activation means the host has confused two
    // activations, and quietly keeping either one binds a child's imports
    // against the wrong module's declarations.
    const f = fixture();
    const section = emptySection();
    f.seed(0, place(f.memory, 4096, section), section.length);
    expect(f.errno()).toBe(0);
    f.seed(0, place(f.memory, 8192, section), section.length);
    expect(f.errno()).toBe(EINVAL);
  });

  it("refuses a section that runs off the end of memory", () => {
    // Wholly past the end, not straddling it. A straddling pointer proves
    // nothing: the decoder reads the header from the in-bounds prefix, sees
    // whatever is there, and rejects the magic -- so the test passes with the
    // bounds check REMOVED, which is what it is supposed to be guarding.
    const f = fixture();
    f.seed(0, f.memory.buffer.byteLength + 4096, 16);
    expect(f.errno()).toBe(EINVAL);
  });
});

/** `WPK_FORK_IMPORTED_GLOBAL_BINDING_*` kinds. */
const KIND_RAW_NUMBER = 1;
const KIND_ACTIVATION_GLOBAL = 4;
const KIND_BASE_IMPORT = 5;

describe("imported-global provenance, the part only the host can resolve", () => {
  it("accepts a carrier coordinate and a raw value", () => {
    const f = fixture();
    f.provenance(3, 1, KIND_ACTIVATION_GLOBAL, 0, 7, 0n);
    expect(f.errno()).toBe(0);
    f.provenance(0, 2, KIND_RAW_NUMBER, 0, 0, 0x4059_0000_0000_0000n);
    expect(f.errno()).toBe(0);
  });

  it("updates a coordinate rather than refusing it", () => {
    // Deliberately unlike the once-only catalogs. A dlopen can add an
    // activation that exports a global an earlier one imports, so the host must
    // be able to correct provenance it published before that activation
    // existed. Refusing would freeze the first answer and leave a child wiring
    // two activations to separate globals they are supposed to share.
    const f = fixture();
    f.provenance(3, 1, KIND_BASE_IMPORT, 0, 0, 0n);
    expect(f.errno()).toBe(0);
    f.provenance(3, 1, KIND_ACTIVATION_GLOBAL, 1, 5, 0n);
    expect(f.errno()).toBe(0);
  });

  it("refuses a kind the record format does not define", () => {
    // The kind drives how a child materialises the import; an undefined one is
    // not something it can fall back from, and this is the boundary where the
    // host's answer enters the module.
    const f = fixture();
    f.provenance(0, 0, 0, 0, 0, 0n);
    expect(f.errno()).toBe(EINVAL);
    f.provenance(0, 0, 99, 0, 0, 0n);
    expect(f.errno()).toBe(EINVAL);
  });
});
