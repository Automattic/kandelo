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
