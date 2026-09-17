import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";

/**
 * Seeding an activation's module template id (census section 139).
 *
 * The 32-byte id is a hash of the guest module BYTES, which only the host
 * holds, so the module is told rather than computing it. It matters because the
 * `Module` record the module now writes into the KFMS arena carries it, and
 * that record is the arena's activation set: the child-install path filters the
 * arena on that record kind to decide which activations to drive. An arena
 * whose activation set is wrong installs the wrong thing rather than failing.
 */

const TEMPLATE_ID_BYTES = 32;
const EINVAL = 22;

function freshModule(): {
  seed: (activation: number, ptr: number) => void;
  errno: () => number;
  memory: WebAssembly.Memory;
  base: number;
} {
  const buf = readFileSync(resolveBinary("fork_module32.wasm"));
  const memory = new WebAssembly.Memory({
    initial: 256,
    maximum: 16384,
    shared: true,
  });
  const base = 8 * 1024 * 1024;
  const fm = instantiateForkModule({
    module: new WebAssembly.Module(buf),
    memory,
    ptrWidth: 4,
    reserve: () => base,
    label: "template id test",
  });
  const exports = fm.exports as Record<string, unknown>;
  (exports.fm_set_format as (pw: number, fixedPrefix: number) => void)(4, 0);
  return {
    seed: exports.fm_set_activation_template_id as (a: number, p: number) => void,
    errno: () => (exports.fm_last_errno as () => number)(),
    memory,
    base,
  };
}

/** Put a distinctive 32-byte id in guest memory and return its address. */
function placeId(memory: WebAssembly.Memory, at: number, fill: number): number {
  new Uint8Array(memory.buffer, at, TEMPLATE_ID_BYTES).fill(fill);
  return at;
}

describe("activation template id seeding", () => {
  it("accepts one id per activation", () => {
    const fm = freshModule();
    fm.seed(0, placeId(fm.memory, 1024, 0xa5));
    expect(fm.errno()).toBe(0);
    fm.seed(1, placeId(fm.memory, 2048, 0x5a));
    expect(fm.errno()).toBe(0);
  });

  it("refuses a second id for an activation it already knows", () => {
    // The id identifies the module behind the activation. A second, different
    // value means the host has confused two activations, and silently keeping
    // the last one would put the wrong module in the arena's activation set --
    // which the child install then drives.
    const fm = freshModule();
    fm.seed(0, placeId(fm.memory, 1024, 0xa5));
    expect(fm.errno()).toBe(0);
    fm.seed(0, placeId(fm.memory, 2048, 0x5a));
    expect(fm.errno()).toBe(EINVAL);
  });

  it("refuses a pointer that runs off the end of memory", () => {
    // The seed reads 32 bytes from guest memory at an address the host chose.
    // A short read past the end would take whatever follows, and a template id
    // is compared, not validated -- so a wrong one is a wrong answer rather
    // than an error.
    const fm = freshModule();
    fm.seed(0, fm.memory.buffer.byteLength - 8);
    expect(fm.errno()).toBe(EINVAL);
  });
});
