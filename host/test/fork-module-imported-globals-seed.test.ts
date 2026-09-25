import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import {
  CHANNEL_BASE,
  MMAP_FLOOR,
  startChannelResponder,
} from "./fork-module-capture-fixture";
import { admit, type AdmissionFacts } from "./support/fork-admission";

/**
 * Admitting an activation's imported-global (KFIG) and imported-table (KFIT)
 * custom sections.
 *
 * The module needs them to build the imported-global bindings a child reads:
 * a section says which globals an activation imports and at what type, which
 * is half of every binding. They arrive in the activation's admission rather
 * than being read because a custom section lives in the `WebAssembly.Module`
 * and only the host can get it out -- `WebAssembly.Module.customSections`. The
 * module cannot reach its guests' modules at all.
 */

const EINVAL = 22;

/** `fm_set_import_provenance` / `fm_set_identity_group` spaces. */
const SPACE_GLOBAL = 0;
const SPACE_TABLE = 1;

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
    reserve: () => 8 * 1024 * 1024,
    label: "kfig seed",
  });
  const x = fm.exports as Record<string, unknown>;
  // A SERVICED CHANNEL, because identity storage is now on-demand: the module
  // `SYS_MMAP`s a chunk when it needs one instead of writing into a fixed
  // static, so a publish without a channel is a truthful `EINVAL` rather than a
  // silent success. `fm_set_format(..., CHANNEL_BASE)` plus the shared
  // responder is what the other module tests already do; this file predated the
  // need for one.
  startChannelResponder({ memory, channelBase: CHANNEL_BASE, floor: MMAP_FLOOR });
  (
    x.fm_set_format as (
      pw: number,
      prefix: number,
      archive: number,
      channelBase: number,
    ) => void
  )(4, 0, 0, CHANNEL_BASE);
  return {
    memory,
    errno: () => (x.fm_last_errno as () => number)(),
    /** `fm_admit_activation`, staged low; the errno it answered. */
    admit: (activation: number, facts: AdmissionFacts) => admit(x, memory, 4096, activation, facts),
    provenance: x.fm_set_import_provenance as (
      space: number,
      consumerActivation: number,
      importOrdinal: number,
      kind: number,
      groupId: number,
      rawBits: bigint,
    ) => void,
    identity: x.fm_set_identity_group as (
      space: number,
      activation: number,
      owner: number,
      groupId: number,
    ) => void,
  };
}

/** A valid `KFIG` section with ONE record -- different bytes from `emptySection`. */
function oneGlobalSection(): Uint8Array {
  const moduleName = new TextEncoder().encode("env");
  const importName = new TextEncoder().encode("g");
  const recordSize = 24 + moduleName.length + importName.length;
  const bytes = new Uint8Array(16 + recordSize);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4b, 0x46, 0x49, 0x47], 0); // "KFIG"
  view.setUint16(4, 1, true); // version
  view.setUint16(6, 16, true); // header size
  view.setUint32(8, 1, true); // one record
  view.setUint32(16, recordSize, true);
  view.setUint32(20, 1, true); // owner id
  bytes[24] = 1; // i32
  bytes[25] = 1; // mutable
  view.setUint32(28, moduleName.length, true);
  view.setUint32(32, importName.length, true);
  view.setUint32(36, 0, true); // import ordinal
  bytes.set(moduleName, 40);
  bytes.set(importName, 40 + moduleName.length);
  return bytes;
}

/** A valid, empty KFIT section: 16-byte header, zero records. */
function emptyTableSection(): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4b, 0x46, 0x49, 0x54], 0); // "KFIT"
  view.setUint16(4, 1, true); // version
  view.setUint16(6, 16, true); // header size
  view.setUint32(8, 0, true); // record count
  view.setUint32(12, 0, true); // reserved
  return bytes;
}

describe("imported-global section admission", () => {
  it("accepts one section per activation", () => {
    const f = fixture();
    const section = emptySection();
    expect(f.admit(0, { importedGlobals: section })).toBe(0);
    expect(f.admit(1, { importedGlobals: section })).toBe(0);
  });

  it("refuses a malformed section at ADMISSION, not at the capture", () => {
    // A bad section is the host's bug. Discovering it when the capture finally
    // reads it means discovering it mid-fork, where a truthful errno has
    // already become a trap.
    const f = fixture();
    const bad = emptySection();
    bad[0] = 0x00; // wrong magic
    expect(f.admit(0, { importedGlobals: bad })).toBe(EINVAL);
  });

  it("refuses a DIFFERENT second section, and ignores an identical one", () => {
    // Two DIFFERENT sections for one activation means the host has confused two
    // activations, and quietly keeping either one binds a child's imports
    // against the wrong module's declarations. That is what this refuses.
    //
    // An IDENTICAL re-admission is a no-op instead, and the reason is a COW
    // fork child: a child and its import planner both admit activations
    // another caller in the same worker may already have admitted -- of the
    // same guest module, hence the same bytes -- and refusing that as a
    // confusion was `errno 22` on 41 test files when the per-section seed did
    // it. Census D9 C2.
    const f = fixture();
    const section = emptySection();
    expect(f.admit(0, { importedGlobals: section })).toBe(0);
    expect(f.admit(0, { importedGlobals: section }), "identical bytes are the same declarations")
      .toBe(0);
    // A VALID section that differs, not a malformed one: a malformed section is
    // refused by the DECODER before the conflict check is reached, so asserting
    // on it proves nothing about the check. Perturbing the check to accept
    // every re-admission left that version of this assertion passing.
    expect(
      f.admit(0, { importedGlobals: oneGlobalSection() }),
      "different bytes are two modules, and are refused",
    ).toBe(EINVAL);
  });
});

/** `WPK_FORK_IMPORTED_GLOBAL_BINDING_*` kinds. */
const KIND_RAW_NUMBER = 1;
const KIND_ACTIVATION_GLOBAL = 4;
const KIND_BASE_IMPORT = 5;

describe("imported-global provenance, the part only the host can resolve", () => {
  it("accepts an identity group and a raw value, keyed by import ordinal", () => {
    const f = fixture();
    f.provenance(SPACE_GLOBAL, 3, 1, KIND_ACTIVATION_GLOBAL, 7, 0n);
    expect(f.errno()).toBe(0);
    f.provenance(SPACE_GLOBAL, 0, 2, KIND_RAW_NUMBER, 0, 0x4059_0000_0000_0000n);
    expect(f.errno()).toBe(0);
  });

  it("updates a group rather than refusing it", () => {
    // Deliberately unlike the once-only catalogs. A dlopen can add an
    // activation that exports a global an earlier one imports, so the host must
    // be able to correct provenance it published before that activation
    // existed. Refusing would freeze the first answer and leave a child wiring
    // two activations to separate globals they are supposed to share.
    const f = fixture();
    f.provenance(SPACE_GLOBAL, 3, 1, KIND_ACTIVATION_GLOBAL, 0, 0n);
    expect(f.errno()).toBe(0);
    f.provenance(SPACE_GLOBAL, 3, 1, KIND_ACTIVATION_GLOBAL, 5, 0n);
    expect(f.errno()).toBe(0);
  });

  it("refuses a kind the record format does not define", () => {
    // The kind drives how a child materialises the import; an undefined one is
    // not something it can fall back from, and this is the boundary where the
    // host's answer enters the module.
    const f = fixture();
    f.provenance(SPACE_GLOBAL, 0, 0, 0, 0, 0n);
    expect(f.errno()).toBe(EINVAL);
    f.provenance(SPACE_GLOBAL, 0, 0, 99, 0, 0n);
    expect(f.errno()).toBe(EINVAL);
  });

  it("refuses BASE_IMPORT, a defined kind that is not the host's to publish", () => {
    // The one kind the host may not say. Claiming it asserts that no activation
    // provides the object, and only the KFIG sections seeded into this module
    // distinguish an activation that OWNS a catalog global from one that merely
    // imports it. The module reaches BASE_IMPORT by election instead.
    const f = fixture();
    f.provenance(SPACE_GLOBAL, 3, 1, KIND_BASE_IMPORT, 0, 0n);
    expect(f.errno()).toBe(EINVAL);
  });
});

describe("global identity groups, the fact wasm cannot compute", () => {
  it("accepts several catalog globals into one group", () => {
    // Two activations naming the same WebAssembly.Global. There is no
    // `global.eq` in wasm, so this equality can only arrive from JavaScript.
    const f = fixture();
    f.identity(SPACE_GLOBAL, 1, 5, 7);
    expect(f.errno()).toBe(0);
    f.identity(SPACE_GLOBAL, 3, 1, 7);
    expect(f.errno()).toBe(0);
  });

  it("updates a membership rather than refusing it", () => {
    // Same reason provenance is re-publishable: a dlopen can introduce an
    // activation that changes who shares what.
    const f = fixture();
    f.identity(SPACE_GLOBAL, 1, 5, 7);
    expect(f.errno()).toBe(0);
    f.identity(SPACE_GLOBAL, 1, 5, 8);
    expect(f.errno()).toBe(0);
  });

  it("refuses owner 0, which names no catalog global", () => {
    // Catalog owner ids are 1-based (`fork_instrument` numbers them from 1), so
    // owner 0 is an unresolved lookup arriving as data. Accepting it would put
    // a member in the group that no activation can provide, and the election
    // would hand a child a coordinate that resolves to nothing.
    const f = fixture();
    f.identity(SPACE_GLOBAL, 1, 0, 7);
    expect(f.errno()).toBe(EINVAL);
  });
});

/** `WPK_FORK_IMPORTED_TABLE_BINDING_*` kinds. */
const KIND_ACTIVATION_TABLE = 1;
const KIND_TABLE_BASE_IMPORT = 2;

describe("two import spaces", () => {
  it("keeps a global section and a table section for the same activation", () => {
    // The spaces are separate namespaces, not a single per-activation slot. An
    // activation normally has both, and admitting one must not read as a
    // conflicting re-admission of the other.
    const f = fixture();
    const globals = emptySection();
    const tables = emptyTableSection();
    expect(f.admit(0, { importedGlobals: globals })).toBe(0);
    expect(
      f.admit(0, { importedGlobals: globals, importedTables: tables }),
      "adding a table section is not a conflict",
    ).toBe(0);
    expect(
      f.admit(0, { importedGlobals: globals, importedTables: tables }),
      "and an identical re-admission is a no-op",
    ).toBe(0);
  });

  it("decodes each space against its own section format", () => {
    // KFIG bytes in the table space are not a table catalog. Accepting them
    // would store a section whose records the capture then reads as tables.
    const f = fixture();
    expect(f.admit(0, { importedTables: emptySection() })).toBe(EINVAL);
  });

  it("refuses a space that names neither catalog", () => {
    // The two sections an admission carries name their own spaces, so a third
    // space can only arrive through the per-coordinate entries.
    const f = fixture();
    f.identity(2, 1, 5, 7);
    expect(f.errno()).toBe(EINVAL);
    f.provenance(2, 3, 1, KIND_ACTIVATION_TABLE, 7, 0n);
    expect(f.errno()).toBe(EINVAL);
  });

  it("holds each space to its own binding kinds", () => {
    // A table import is always a WebAssembly.Table, so the value kinds a global
    // can take are not sayable about one -- and BASE_IMPORT stays an election
    // result in both spaces.
    //
    // THE TWO KIND NUMBERINGS OVERLAP, which is why the space has to reach the
    // check at all: 1 is RAW_NUMBER among globals and ACTIVATION_TABLE among
    // tables, and 2 is RAW_BIGINT against BASE_IMPORT. A kind byte means
    // nothing without the space beside it, so the global-only kind used here is
    // 4, which no table kind claims.
    const f = fixture();
    f.provenance(SPACE_TABLE, 3, 1, KIND_ACTIVATION_TABLE, 7, 0n);
    expect(f.errno(), "identity is all a table import can carry").toBe(0);
    f.provenance(SPACE_TABLE, 3, 2, KIND_ACTIVATION_GLOBAL, 7, 0n);
    expect(f.errno(), "a global kind is not a table kind").toBe(EINVAL);
    f.provenance(SPACE_TABLE, 3, 3, KIND_TABLE_BASE_IMPORT, 0, 0n);
    expect(f.errno(), "BASE_IMPORT is the module's conclusion").toBe(EINVAL);
  });

  it("keeps the two spaces' identity groups apart", () => {
    // Group 7 of the globals and group 7 of the tables are different objects.
    // One table keyed only by (activation, owner) would have the second
    // publication overwrite the first.
    const f = fixture();
    f.identity(SPACE_GLOBAL, 1, 5, 7);
    expect(f.errno()).toBe(0);
    f.identity(SPACE_TABLE, 1, 5, 9);
    expect(f.errno()).toBe(0);
  });
});
