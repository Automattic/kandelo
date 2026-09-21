// WHY THIS EXISTS: `fm_publish_resume_assignment` writes a packed record
// buffer that a DIFFERENT implementation reads.
//
// The writer is Rust (`crates/fork-module/src/lib.rs`,
// `publish_resume_assignment_impl`). The reader is wasm emitted instruction by
// instruction (`crates/fork-instrument/src/instrument.rs`,
// `emit_resume_placement_shim`, exported into every instrumented guest as
// `__wpk_fork_place_resume_thunks`). Neither can see the other's constants.
//
// A disagreement about stride, field order or width between those two fails no
// compiler and trips no trap. It places REAL thunks at PLAUSIBLE WRONG SLOTS,
// which is precisely the silent corruption `host/src/fork-resume-table.ts`
// documents at census 194: the guest `call_indirect`s a live function of the
// right type that is the wrong function, and nothing anywhere reports it.
//
// So the second half of this file drives the real emitted shim over a buffer
// the real module really wrote, in one shared `WebAssembly.Memory`, and checks
// funcref IDENTITY at each slot. A test that packed the buffer with its own
// constants and unpacked it with its own constants could not detect the
// disagreement it exists to detect -- it would be checking this file against
// itself. The first half characterizes the module's side alone, which is worth
// having but is not that check.
//
// # What is REAL here
//
// The shipped fork module (`fork_module32.wasm`), the resume table it owns and
// exports, the slot allocator inside it, a real SDK/`fork-instrument`-built
// guest with its own resume catalog and its own emitted placement shim, and
// `buildForkGuestImports` -- the production builder for a guest's fork `env`.
//
// Nothing here mints a stand-in for the thing under test.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { buildForkGuestImports } from "../src/fork-guest-imports";
import { instantiateForkModule } from "../src/fork-module-instance";
import { artifactGate } from "./support/artifact-gate";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");

/**
 * Big enough for the guest AND the module, which is not the usual harness
 * arithmetic. The instrumented fixture declares `(import "env" "memory"
 * (memory 146 16384 shared))`, so its own layout claims the first 9.6 MiB.
 * Placing the fork module's region at the 8 MiB the other resume harnesses use
 * would drop it inside that claim.
 */
const MEMORY_PAGES = 512;
const MODULE_BASE = 16 * 1024 * 1024;
/**
 * Inert in this file: nothing here issues a syscall or spills a published
 * buffer to a mapping, and both of those are the only things that read it.
 * `fm_set_format` still wants it, and the guest still imports
 * `__channel_base`, so it has to be a real address rather than zero.
 */
const CHANNEL_BASE = 12 * 1024 * 1024;
/** Scratch the ordinal catalogs are staged at, above both regions. */
const CATALOG_AT = 20 * 1024 * 1024;

/** The record layout, restated from the SHIM rather than from the writer. */
const RECORD_BYTES = 8;
const RECORD_ORDINAL_OFFSET = 0;
const RECORD_SLOT_OFFSET = 4;

interface Published {
  readonly ptr: number;
  readonly count: number;
}

interface Harness {
  readonly memory: WebAssembly.Memory;
  readonly exports: Record<string, unknown>;
  readonly resumeTable: WebAssembly.Table;
  /** Seed an activation's catalog, which is what assigns its slots. */
  readonly seed: (activationId: number, ordinals: readonly number[]) => void;
  readonly release: (activationId: number) => number;
  readonly slotOf: (activationId: number, ordinal: number) => number;
  readonly publish: (activationId: number) => Published;
  readonly errno: () => number;
}

function harness(): Harness {
  const memory = new WebAssembly.Memory({
    initial: MEMORY_PAGES,
    maximum: 16384,
    shared: true,
  });
  const fm = instantiateForkModule({
    module: new WebAssembly.Module(
      readFileSync(resolveBinary("fork_module32.wasm")),
    ),
    memory,
    ptrWidth: 4,
    reserve: () => MODULE_BASE,
    label: "resume assignment",
  });
  const x = fm.exports as Record<string, unknown>;
  // The format resets the catalogs, so it has to come first -- the same
  // ordering `ForkModuleContinuationBackend.setup()` documents.
  (x.fm_set_format as (...a: number[]) => void)(4, 0, 0, 0, CHANNEL_BASE);

  const errno = () => (x.fm_last_errno as () => number)();
  const resumeSlots = x.fm_resume_slots as (
    op: number,
    activation: number,
    ordinal: number,
  ) => number;

  const seed = (activationId: number, ordinals: readonly number[]): void => {
    const bytes = new Uint8Array(ordinals.length * 4);
    const view = new DataView(bytes.buffer);
    ordinals.forEach((o, i) => view.setUint32(i * 4, o >>> 0, true));
    new Uint8Array(memory.buffer, CATALOG_AT, bytes.length).set(bytes);
    (x.fm_set_activation_resume_catalog as (a: number, p: number, c: number) => void)(
      activationId,
      CATALOG_AT,
      ordinals.length,
    );
    expect(errno(), `seeding activation ${activationId}`).toBe(0);
  };

  const publish = (activationId: number): Published => {
    const packed = (
      x.fm_publish_resume_assignment as (a: number) => bigint
    )(activationId);
    if (packed === -1n) {
      throw new Error(
        `publishing activation ${activationId} failed with errno ${errno()}`,
      );
    }
    // COUNT HIGH, POINTER LOW -- see the export's own doc comment. A pointer in
    // the high half would make any buffer above 2 GiB decode as a negative
    // i64, which is the error signal.
    return {
      ptr: Number(packed & 0xffff_ffffn),
      count: Number(packed >> 32n),
    };
  };

  return {
    memory,
    exports: x,
    resumeTable: x.__wpk_fork_resume_table as unknown as WebAssembly.Table,
    seed,
    release: (activationId) => resumeSlots(1, activationId, 0),
    slotOf: (activationId, ordinal) => resumeSlots(0, activationId, ordinal),
    publish,
    errno,
  };
}

/** Decode `count` records at `ptr`, using the SHIM's offsets. */
function readRecords(
  memory: WebAssembly.Memory,
  { ptr, count }: Published,
): { ordinal: number; slot: number }[] {
  const view = new DataView(memory.buffer);
  const records: { ordinal: number; slot: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = ptr + index * RECORD_BYTES;
    records.push({
      ordinal: view.getUint32(at + RECORD_ORDINAL_OFFSET, true),
      slot: view.getUint32(at + RECORD_SLOT_OFFSET, true),
    });
  }
  return records;
}

describe("fm_publish_resume_assignment", () => {
  it("publishes every (ordinal, slot) the module assigned, ascending", () => {
    const h = harness();
    // Deliberately unsorted, and deliberately not dense: the module sorts the
    // catalog before assigning, so the published order is a property of the
    // publisher rather than of what the host happened to pass.
    h.seed(0, [7, 1, 4]);

    const published = h.publish(0);
    expect(h.errno()).toBe(0);
    expect(published.count).toBe(3);
    expect(published.ptr).toBeGreaterThan(0);

    const records = readRecords(h.memory, published);
    expect(records.map((r) => r.ordinal)).toEqual([1, 4, 7]);
    // Against the module's own answer for the same coordinate, not against a
    // number this file predicted.
    for (const { ordinal, slot } of records) {
      expect(slot, `slot published for ordinal ${ordinal}`).toBe(
        h.slotOf(0, ordinal),
      );
    }
    // Slot 0 is the reserved `resume_peek` sentinel, and the shim TRAPS on a
    // record naming it. A publisher that emitted one would turn every
    // "run the lexical callee" answer into a resumed thunk.
    expect(records.every((r) => r.slot > 0)).toBe(true);
  });

  it("publishes an empty buffer for an activation that holds no slots", () => {
    const h = harness();
    // A side module with no fork-instrumented function seeds an EMPTY catalog
    // and therefore holds no slots -- `libneeded-provider.so` in
    // `fork-from-dlopen-side-module-e2e` is exactly that. Treating it as an
    // error once cost a real fork (see `resume_unregister_impl`).
    h.seed(3, []);
    const empty = h.publish(3);
    expect(h.errno()).toBe(0);
    expect(empty).toEqual({ ptr: 0, count: 0 });

    // And an activation nobody ever seeded answers the same way, for the same
    // reason: "was this registered" is a question the host already answers.
    const unknown = h.publish(41);
    expect(h.errno()).toBe(0);
    expect(unknown).toEqual({ ptr: 0, count: 0 });
  });

  it("publishes the allocator's reuse, not a fresh ascending numbering", () => {
    const h = harness();
    // Fill slots 1..5, then take 6..7, then free the first five. A publisher
    // that re-derived a numbering instead of reading the one the allocator
    // made would answer 1..2 for activation 0 here.
    h.seed(9, [0, 1, 2, 3, 4]);
    h.seed(0, [0, 1]);
    expect(h.release(9)).toBe(5);
    h.seed(1, [0, 1]);

    expect(readRecords(h.memory, h.publish(0))).toEqual([
      { ordinal: 0, slot: 6 },
      { ordinal: 1, slot: 7 },
    ]);
    // Smallest free slot first, which is the fourth of the allocator's rules.
    expect(readRecords(h.memory, h.publish(1))).toEqual([
      { ordinal: 0, slot: 1 },
      { ordinal: 1, slot: 2 },
    ]);
  });

  it("survives the per-fork bump-heap reset", () => {
    const h = harness();
    h.seed(0, [0, 1, 2]);
    const before = h.publish(0);
    const recordsBefore = readRecords(h.memory, before);

    // THE RESET HAZARD, reached the cheapest honest way. `fm_capture_begin` is
    // a fork's single bump-heap reset point ("Make it the fork's SINGLE
    // bump-heap reset point", `crates/fork-module/src/lib.rs`), so calling it
    // puts the module in the state a published buffer has to survive. A buffer
    // allocated from the bump heap would be reclaimed here, and the pointer
    // the host is still holding would address whatever the next allocation
    // put there.
    (h.exports.fm_capture_begin as () => void)();

    const after = h.publish(0);
    expect(h.errno()).toBe(0);
    expect(after.ptr).toBe(before.ptr);
    expect(after.count).toBe(before.count);
    expect(readRecords(h.memory, after)).toEqual(recordsBefore);
  });
});

// --- The seam: the module writes, the EMITTED SHIM reads ---------------------

/**
 * A real instrumented guest, not a WAT stand-in.
 *
 * `native_fork.instrumented.wasm` is built by
 * `crates/host-native/fixtures/build-fixtures.sh` through the same
 * `fork-instrument` path every shipped program takes, so its
 * `__wpk_fork_place_resume_thunks` is the export production guests carry. It
 * has three catalog entries, imports `env.memory` shared (so it can be
 * co-resident with the module) and imports `env.__wpk_fork_resume_table`,
 * which is the table the module owns.
 *
 * It also has NO start section and only PASSIVE data segments, which is what
 * makes instantiating it here safe: nothing runs and nothing is written to
 * memory until something calls an export.
 */
const GUEST_FIXTURE = join(
  REPO_ROOT,
  "crates/host-native/fixtures/native_fork.instrumented.wasm",
);

const { skip } = artifactGate("fork resume-assignment seam", [
  {
    what: "crates/host-native/fixtures/native_fork.instrumented.wasm",
    present: existsSync(GUEST_FIXTURE),
    build: "bash crates/host-native/fixtures/build-fixtures.sh",
  },
]);

const PLACE_EXPORT = "__wpk_fork_place_resume_thunks";
const CATALOG_EXPORT = "__wpk_fork_resume_catalog";

/**
 * THE FIXTURE HAS TWO CONSUMERS AND ONLY ONE HAD A FRESHNESS GATE.
 *
 * `crates/host-native/src/fixtures.rs` rebuilds these artifacts when anything
 * they are built FROM is newer, and `c8789ac27` repaired that check by adding
 * `crates/fork-instrument` to its input set -- the instrumenter is as much an
 * input as libc, because `build-fixtures.sh` runs it over the instrumented
 * arm. But that gate lives in Rust provisioning, and THIS file is vitest
 * loading the artifact by path. It bypasses the gate entirely.
 *
 * That is not hypothetical. The first version of this file was reviewed
 * against a fixture built at 00:08 while `instrument.rs` changed at 00:27, so
 * its shim predated Task 2's reserved-slot guard: the seam was proven against
 * a READER THAT NO LONGER EXISTS. The record layout happened to be identical
 * across those two revisions, so the layout verdict survived -- but that was
 * luck, not the test's doing, and the next instrumenter change will not be so
 * kind.
 *
 * # Why a staleness gate and not a recorded fingerprint
 *
 * `fork-resume-placement-baseline.test.ts` fingerprints its guests, and that
 * is right for the question it asks: "did the recorded mapping's inputs
 * change?", where a recorded sha256 is the only way to notice. The question
 * HERE is different -- "is this artifact older than the thing that produces
 * it?" -- and a recorded hash answers it badly. It would have to be re-recorded
 * on every instrumenter change, which is a ceremony that drifts, and a
 * re-record by a tired hand is exactly how a stale artifact gets blessed. An
 * mtime watermark over the real input closure needs no recorded constant, so
 * it cannot drift, and adding an input can only make it stricter. These
 * artifacts are gitignored build products, so their mtimes are build times
 * rather than checkout times, which is what makes the comparison meaningful.
 *
 * It FAILS rather than skips. A missing artifact is `artifactGate`'s business
 * and a skip is a defensible answer to it; a STALE one is worse than missing,
 * because it runs, reports green, and says nothing about the code in the tree.
 */
const FIXTURE_INPUT_ROOTS = [
  "crates/fork-instrument/src",
  "crates/host-native/fixtures",
] as const;
const FIXTURE_INPUT_FILES = [
  "crates/fork-instrument/Cargo.toml",
  "scripts/run-wasm-fork-instrument.sh",
  "libc/glue/channel_syscall.c",
  "sysroot/lib/libc.a",
  "sysroot64/lib/libc.a",
] as const;
/** Only the SOURCES in the fixtures directory; the outputs live there too. */
const FIXTURE_SOURCE_EXTENSIONS = [".c", ".wat", ".sh"];

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    // A missing input cannot raise the watermark. This check answers "cannot
    // tell" rather than failing, the same way its Rust twin does.
    return 0;
  }
}

function newestUnder(directory: string, extensions: string[] | null): number {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Walked, not hand-listed, so a NEW source file counts without anyone
      // remembering to add it -- the omission `c8789ac27` closed was exactly a
      // hand-listed input set missing one.
      newest = Math.max(newest, newestUnder(path, extensions));
      continue;
    }
    if (extensions !== null && !extensions.some((e) => entry.name.endsWith(e))) {
      continue;
    }
    newest = Math.max(newest, mtimeOf(path));
  }
  return newest;
}

/** Throw, naming the rebuild, if the fixture predates anything it is built from. */
function requireFixtureNotStale(): void {
  const built = mtimeOf(GUEST_FIXTURE);
  const newestInput = Math.max(
    ...FIXTURE_INPUT_ROOTS.map((rel) =>
      newestUnder(
        join(REPO_ROOT, rel),
        rel.endsWith("fixtures") ? FIXTURE_SOURCE_EXTENSIONS : null,
      ),
    ),
    ...FIXTURE_INPUT_FILES.map((rel) => mtimeOf(join(REPO_ROOT, rel))),
  );
  if (built >= newestInput) return;
  throw new Error(
    `crates/host-native/fixtures/native_fork.instrumented.wasm was built at ` +
      `${new Date(built).toISOString()}, which is OLDER than something it is ` +
      `built from (newest input: ${new Date(newestInput).toISOString()}).\n` +
      `This test proves that the fork module's published record buffer and ` +
      `the guest's emitted placement shim agree. A stale fixture carries an ` +
      `OLD shim, so a green run would be a verdict about a reader that is no ` +
      `longer in the tree.\n` +
      `Rebuild with: scripts/dev-shell.sh bash ` +
      `crates/host-native/fixtures/build-fixtures.sh`,
  );
}

/** Instantiate the guest co-resident with the module, on its memory. */
function instantiateGuest(h: Harness, activationId: number): {
  place: (ptr: number, count: number) => number;
  catalog: WebAssembly.Table;
} {
  // Checked HERE rather than in one dedicated case, so no seam case can be
  // added later that reaches the fixture without passing the gate. A gate a
  // caller must remember to call is the same gap this closes.
  requireFixtureNotStale();
  const guestModule = new WebAssembly.Module(readFileSync(GUEST_FIXTURE));
  // THE PRODUCTION BUILDER. It binds `__wpk_fork_resume_table` (and the transit
  // table, and the unwind tag) from the module's own exports, which is the
  // whole point: the table the guest writes into is the table the module
  // numbers, as one object rather than a per-caller convention.
  const env = buildForkGuestImports({
    moduleExports: h.exports,
    guestModule,
    label: "resume assignment seam guest",
    // `memory` and `__channel_base` are not fork imports, so the builder's
    // completeness check (bounded to the `__wpk_fork_*` namespace) neither
    // demands nor sweeps them; they pass through `extras` untouched. The
    // resume table is deliberately absent: the module exports it, and the
    // builder binds it from `moduleExports` -- which is the whole reason the
    // table the guest writes into is the table the module numbers.
    extras: {
      memory: h.memory,
      __channel_base: new WebAssembly.Global(
        { value: "i32", mutable: true },
        CHANNEL_BASE,
      ),
      __wpk_fork_module_activation: new WebAssembly.Global(
        { value: "i32", mutable: false },
        activationId,
      ),
      __wpk_fork_module_state_table_generation_addr: new WebAssembly.Global(
        { value: "i64", mutable: false },
        0n,
      ),
    },
  });
  // The fixture's only other imports are the `kernel` syscall namespace, and
  // nothing here calls a syscall: the placement shim reads memory and writes a
  // table. Stubbed from the artifact's own import list rather than a hardcoded
  // set, so a fixture that grows one is linked rather than failing with a
  // LinkError naming an index. They are `() => 0` and unreachable; if one is
  // ever reached, the test that reaches it is doing something this file does
  // not claim to cover.
  const namespaces: Record<string, Record<string, WebAssembly.ImportValue>> = {
    env: env as Record<string, WebAssembly.ImportValue>,
  };
  for (const descriptor of WebAssembly.Module.imports(guestModule)) {
    if (descriptor.module === "env") continue;
    if (descriptor.kind !== "function") {
      throw new Error(
        `the fixture imports ${descriptor.module}.${descriptor.name} as a ` +
          `${descriptor.kind}; this harness only stubs functions outside env`,
      );
    }
    (namespaces[descriptor.module] ??= {})[descriptor.name] =
      (() => 0) as unknown as WebAssembly.ImportValue;
  }
  const instance = new WebAssembly.Instance(
    guestModule,
    namespaces as unknown as WebAssembly.Imports,
  );
  const place = instance.exports[PLACE_EXPORT];
  if (typeof place !== "function") {
    throw new Error(`the instrumented fixture does not export ${PLACE_EXPORT}`);
  }
  const catalog = instance.exports[CATALOG_EXPORT];
  if (!(catalog instanceof WebAssembly.Table)) {
    throw new Error(`the instrumented fixture does not export ${CATALOG_EXPORT}`);
  }
  return {
    place: place as (ptr: number, count: number) => number,
    catalog,
  };
}

describe.skipIf(skip)("fork resume-assignment seam", () => {
  it("the guest's own shim places from a buffer the module wrote", () => {
    const h = harness();
    const { place, catalog } = instantiateGuest(h, 0);
    // Stated rather than assumed: a one-entry catalog would make the permuted
    // assignment below indistinguishable from an identity one.
    expect(catalog.length, "fixture catalog entries").toBeGreaterThanOrEqual(3);
    const ordinals = [0, 1, 2];

    // Push activation 0's slots AWAY from its ordinals, so "the ordinal is the
    // slot" and "place in argument order" both fail. Filler takes 1..5; then
    // activation 0 takes 6..8.
    h.seed(9, [0, 1, 2, 3, 4]);
    h.seed(0, ordinals);
    const published = h.publish(0);
    expect(published.count).toBe(ordinals.length);

    // THE SEAM, AND IT RUNS BEFORE ANY EXPECTATION ABOUT THE BYTES. The module
    // wrote those bytes; this is the emitted wasm reading them, with no value
    // crossing through JavaScript in between -- the pointer is an offset into
    // the memory both modules share.
    //
    // THE ORDER HERE IS LOAD-BEARING, and a perturbation proved it. Asserting
    // the decoded records first sounds harmless and is not: swapping the
    // writer's two fields failed that assertion and RETURNED, so this case
    // never reached the shim at all and the seam went unexercised on the very
    // run that was meant to exercise it. Placement first means a writer that
    // disagrees with the reader is caught BY the reader -- as a trap, or as a
    // thunk at the wrong slot -- which is the failure this file exists to see.
    const placed = place(published.ptr, published.count);
    // NOT a success tally. The shim returns max(count, 0); every failure mode
    // in it traps, so this only says the record count was not negative.
    expect(placed, "the shim's requested-record count").toBe(published.count);

    const expected = readRecords(h.memory, published);

    // IDENTITY, not equality, and checked BEFORE any size assertion: a merely
    // equal funcref is a thunk from somewhere else, and a size check first
    // would report the symptom instead of the property.
    for (const { ordinal, slot } of expected) {
      const thunk = catalog.get(ordinal) as WebAssembly.ExportValue | null;
      expect(thunk, `catalog ordinal ${ordinal} is null`).not.toBeNull();
      expect(
        h.resumeTable.get(slot),
        `slot ${slot} must hold the guest's own catalog thunk for ordinal ` +
          `${ordinal}`,
      ).toBe(thunk);
    }

    // The coordinates themselves, pinned AFTER the identity loop rather than
    // before it. The loop above reads its slots out of the same buffer the
    // shim read, so on its own it could pass while agreeing with a wrong
    // answer; this says which answer is right. It runs late so that a wrong
    // buffer is reported as a placement failure first -- the property -- and
    // only then as the wrong numbers.
    expect(expected).toEqual([
      { ordinal: 0, slot: 6 },
      { ordinal: 1, slot: 7 },
      { ordinal: 2, slot: 8 },
    ]);

    // The growth is the SHIM's: the module declares the resume table with one
    // entry and no maximum, and nothing on this side grew it.
    expect(h.resumeTable.length).toBe(9);
    // Nothing anywhere else, including the reserved sentinel at slot 0.
    const occupied = new Set(expected.map((r) => r.slot));
    for (let slot = 0; slot < h.resumeTable.length; slot += 1) {
      if (occupied.has(slot)) continue;
      expect(
        h.resumeTable.get(slot),
        `slot ${slot} holds a thunk nobody published`,
      ).toBeNull();
    }
  });

  it("places a second activation into the slots the allocator reused", () => {
    const h = harness();
    const { place, catalog } = instantiateGuest(h, 0);
    // The same guard case 1 carries, and it was missing here. Without it every
    // `toBe(catalog.get(ordinal))` below could compare null against null and
    // pass while nothing had been placed at all -- a case that cannot fail is
    // not evidence, and this one is run in isolation often enough to matter.
    expect(catalog.length, "fixture catalog entries").toBeGreaterThanOrEqual(3);
    const ordinals = [0, 1, 2];

    h.seed(9, [0, 1, 2, 3, 4]);
    h.seed(0, ordinals);
    const first = h.publish(0);
    expect(place(first.ptr, first.count)).toBe(first.count);
    // Freeing the filler puts 1..5 back at the front of the free list, so the
    // next activation lands BELOW activation 0 -- a descending relationship the
    // published buffer has to carry and the shim has to honour.
    expect(h.release(9)).toBe(5);
    h.seed(1, ordinals);

    const published = h.publish(1);
    // Placed first, then read, for the reason the case above records: an
    // expectation about the BYTES that runs ahead of the shim can fail without
    // the shim ever running.
    expect(place(published.ptr, published.count)).toBe(published.count);

    const records = readRecords(h.memory, published);
    for (const { ordinal, slot } of records) {
      const thunk = catalog.get(ordinal) as WebAssembly.ExportValue | null;
      expect(thunk, `catalog ordinal ${ordinal} is null`).not.toBeNull();
      expect(
        h.resumeTable.get(slot),
        `slot ${slot} must hold the catalog thunk for ordinal ${ordinal}`,
      ).toBe(thunk);
    }
    expect(records).toEqual([
      { ordinal: 0, slot: 1 },
      { ordinal: 1, slot: 2 },
      { ordinal: 2, slot: 3 },
    ]);
    // Activation 0's thunks are still where the first placement put them: the
    // second publish rewrote the shared buffer, not the table.
    for (const slot of [6, 7, 8]) {
      expect(h.resumeTable.get(slot), `slot ${slot} lost its thunk`).not.toBeNull();
    }
  });

  it("the reader still refuses slot 0, which this publisher never emits", () => {
    const h = harness();
    const { place, catalog } = instantiateGuest(h, 0);
    expect(catalog.length, "fixture catalog entries").toBeGreaterThanOrEqual(3);

    // THE OTHER HALF OF THE FRESHNESS QUESTION, asked behaviourally.
    //
    // The mtime gate above says the artifact is not older than its producer.
    // This says the artifact still HAS the property this publisher depends on,
    // which is a different question and the one that actually bit: the shim
    // gained its reserved-slot guard in a revision later than the fixture that
    // the first review ran against, and nothing noticed, because no case ever
    // asked the reader to refuse anything.
    //
    // Slot 0 is the `resume_peek` "run the lexical callee" sentinel and must
    // stay null for the life of the process. `resume_allocate_slot` starts at
    // 1, so this module never publishes a record naming it -- which means the
    // guard is a contract the publisher RELIES ON and never exercises. A
    // zeroed or stale buffer decodes to (ordinal 0, slot 0), and both are in
    // range, so only the reservation makes it wrong.
    const PAIRS = 24 * 1024 * 1024;
    const view = new DataView(h.memory.buffer);
    view.setUint32(PAIRS, 2, true); // a real, live catalog ordinal
    view.setUint32(PAIRS + 4, 0, true); // the reserved sentinel
    expect(
      () => place(PAIRS, 1),
      "an instrumented guest whose shim does not refuse slot 0 predates " +
        "the reserved-sentinel guard; rebuild the fixture with " +
        "crates/host-native/fixtures/build-fixtures.sh",
    ).toThrow(WebAssembly.RuntimeError);
    expect(
      h.resumeTable.get(0),
      "the reserved resume_peek sentinel was overwritten",
    ).toBeNull();
  });
});
