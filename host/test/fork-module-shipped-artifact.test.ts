// The SHIPPED fork module must not contradict itself, and must instantiate.
//
// Lane F's merge into the parent shipped a `fork_module32.wasm` whose import
// section asked for `__indirect_function_table` at `initial=2` while the
// `dylink.0` MEM_INFO record it carries for exactly that purpose said the
// module needs 0 table slots. The host does not invent a size: it reads that
// record (`readDylinkMemInfo`) and passes the value straight to
// `new WebAssembly.Table({ initial })`. So every fork-instrumented process on
// every host died at instantiation with
//
//     LinkError: table import 1 is smaller than initial 2, got 0
//
// and no process that forks could start at all.
//
// NOTHING CAUGHT IT. `fork-module-instance.test.ts` was 6/6 green against the
// broken tree because it builds its fixtures from WAT; the surface budget was
// 109 green; the host baseline matched its baseline. The first thing that
// failed was booting a real kernel. A module is a build OUTPUT, and the whole
// suite was testing inputs.
//
// These assertions therefore run against the artifact the host actually loads,
// resolved the same way `worker-main` resolves it. They are cheap -- parsing a
// custom section and one instantiation -- and they are the only place anything
// reads the shipped bytes.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";

const PAGE = 65536;

function shippedModuleBytes(width: 32 | 64 = 32): Uint8Array {
  return readFileSync(resolveBinary(`fork_module${width}.wasm`));
}

/**
 * Both widths ship, and `worker-main` picks between them by the GUEST's
 * pointer width -- so a wasm64 guest loads `fork_module64.wasm` and meets the
 * same failure mode. The byte-level assertions below therefore run over both.
 * Only the instantiation check is 32-only: standing up a wasm64 instance needs
 * a memory64, which the host creates only for a wasm64 guest, and a guard that
 * cannot run is worse than one with a stated boundary.
 */
const WIDTHS = [32, 64] as const;

/** The third LEB of the dylink.0 MEM_INFO record, which is what the host reads. */
function dylinkTableSize(bytes: Uint8Array): number {
  let offset = 8;
  const leb = (source: Uint8Array, cursor: { at: number }): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = source[cursor.at++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0;
  };
  while (offset < bytes.length) {
    const id = bytes[offset++];
    const cursor = { at: offset };
    const size = leb(bytes, cursor);
    offset = cursor.at;
    const body = bytes.subarray(offset, offset + size);
    if (id === 0) {
      const inner = { at: 0 };
      const nameLength = leb(body, inner);
      const name = new TextDecoder().decode(
        body.subarray(inner.at, inner.at + nameLength),
      );
      if (name === "dylink.0") {
        const section = body.subarray(inner.at + nameLength);
        const walk = { at: 0 };
        walk.at += 1; // subsection kind; MEM_INFO is 1 and is emitted first
        leb(section, walk); // subsection size
        leb(section, walk); // memorySize
        leb(section, walk); // memoryAlign
        return leb(section, walk); // tableSize -- the value the host uses
      }
    }
    offset += size;
  }
  throw new Error("the shipped fork module carries no dylink.0 section");
}

describe("the shipped fork module", () => {
  it.each(WIDTHS)("declares a dylink table size the host can honour (%i-bit)", (width) => {
    // THE INVARIANT THE MERGE BROKE. Two places state how many slots
    // `__indirect_function_table` needs: the import's `initial`, which the
    // ENGINE enforces, and the dylink record, which the HOST believes and
    // passes to `new WebAssembly.Table({ initial })`. When they disagree the
    // engine wins and every instantiation fails.
    //
    // The disagreement is caught by the instantiation test below, through the
    // real host path, which is the only way to compare the two without
    // decoding table limits by hand. What this asserts is the cheaper half:
    // the record exists, is readable, and is not the zero that a module with
    // injected element entries cannot legitimately have.
    const tableSize = dylinkTableSize(shippedModuleBytes(width));
    expect(Number.isInteger(tableSize)).toBe(true);
    expect(tableSize).toBeGreaterThan(0);
  });

  it.each(WIDTHS)("carries every table import the host binds (%i-bit)", (width) => {
    // The broken module had TWO table imports; a correct one has three. The
    // missing one was `__wpk_fork_drive_table`, which the injector adds -- so a
    // module without it is one whose injection did not finish, a different
    // defect from a size mismatch even though both land at instantiation.
    //
    // Read through `WebAssembly.Module.imports()` rather than a hand-rolled
    // section walk: the engine already decodes this, and a second decoder here
    // is one more thing that can be wrong about the bytes it is policing.
    const module = new WebAssembly.Module(shippedModuleBytes(width));
    const tables = WebAssembly.Module.imports(module)
      .filter((entry) => entry.kind === "table")
      .map((entry) => entry.name);
    expect(tables).toContain("__indirect_function_table");
    expect(tables).toContain("__wpk_fork_function_catalog");
    expect(tables).toContain("__wpk_fork_drive_table");
  });

  it.each(WIDTHS)("agrees across every staged copy, so no tier shadows a fresh build (%i-bit)", (width) => {
    // `resolveBinary` does NOT return the file the build script last wrote.
    // It walks ARTIFACT_TIERS, and `local-binaries/source-only-v1` is FIRST --
    // so a stale module there shadows the fresh one in `local-binaries/` and
    // `host/wasm/`. Census 90 recorded exactly that happening: "The tier kept a
    // three-hour-old fork_module32.wasm while local-binaries/ had the fresh
    // one."
    //
    // This is also why perturbing `host/wasm/fork_module32.wasm` to prove this
    // file's guards SURVIVED: the test never reads that copy. A reader
    // reaching for the obvious file to check a claim here would be checking
    // the wrong bytes, which is the same trap in miniature.
    //
    // Absence is not a failure -- not every tree stages every path -- but
    // disagreement is.
    const resolved = resolveBinary(`fork_module${width}.wasm`);
    const canonical = readFileSync(resolved);
    const staged = [
      join(import.meta.dirname, "..", "wasm", `fork_module${width}.wasm`),
      join(import.meta.dirname, "..", "..", "local-binaries", `fork_module${width}.wasm`),
    ];
    for (const path of staged) {
      if (!existsSync(path) || path === resolved) continue;
      expect(
        Buffer.compare(readFileSync(path), canonical),
        `${path} differs from the artifact the host resolves (${resolved}); ` +
          `a stale tier copy shadows the fresh build`,
      ).toBe(0);
    }
  });

  it("instantiates through the host's own path", () => {
    // The end-to-end claim, using `instantiateForkModule` rather than a
    // hand-rolled import object, because the defect was in what the HOST
    // derives from the module -- a test that supplies its own tables would
    // have passed against the broken artifact.
    const bytes = shippedModuleBytes();
    const memory = new WebAssembly.Memory({ initial: 700, maximum: 4096, shared: true });
    let next = 16 * 1024 * 1024;
    expect(() =>
      instantiateForkModule({
        module: new WebAssembly.Module(bytes),
        memory,
        ptrWidth: 4,
        reserve: (size: number) => {
          const base = next;
          next += Math.ceil(size / PAGE) * PAGE;
          return base;
        },
        label: "shipped-artifact guard",
      }),
    ).not.toThrow();
  });
});
