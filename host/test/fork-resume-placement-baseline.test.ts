// WHY THIS EXISTS: the spec says the test that matters for this change is
// "that every activation's thunks land at the same slots they do now -- a
// before/after comparison, not a new assertion". Nothing could produce that
// comparison before this file. It reads the resume TABLE rather than asking
// `fm_resume_slots`, because op 0 is deleted by this same change.
//
// # What is REAL here and what is a stand-in
//
// Real: the fork module (`fork_module32.wasm`, the shipped artifact), the
// resume table it owns and exports, the slot allocator inside it, the
// `kandelo.wpk_fork.resume_catalog` sections of two SDK-built, fork-
// instrumented guests, and the host placement path production uses today
// (`ForkResumeTable.registerActivation`, the one function behind all three
// `registerActivation` sites at `host/src/worker-main.ts:1034`, `:4662` and
// `:6971`).
//
// A stand-in: the thunk OBJECTS. Placement does not read them -- the slot is a
// function of the seeded ordinal and nothing else -- so each is a distinct
// live Wasm function minted here, which is what makes the read-back possible
// at all: the mapping is recovered by scanning the table and matching funcref
// IDENTITY, not by trusting what this file passed in.
//
// # Why two activations, and why THIS fixture
//
// `buildVforkSideModuleFixture()` is the dlopen side-module fixture
// `fork-from-dlopen-side-module-e2e` runs: an SDK-built main program plus a
// side module it dlopens, both fork-instrumented through
// `scripts/run-wasm-fork-instrument.sh`. It is the smallest thing in the tree
// that yields two REAL resume catalogs, and the only multi-activation
// alternative -- the end-to-end tests -- place their thunks inside a worker
// this process cannot reach. Its shape is also the one that matters: a large
// main-module catalog and a one-entry side-module catalog, so the recorded
// baseline covers the cross-activation offset as well as the within-
// activation ordering.
//
// # The table identity caveat
//
// One resume table per WORKER, not per activation: the module defines and
// exports it (`crates/fork-module-inject/src/main.rs:1042-1044`) and every
// guest in that worker imports the same object by reference. This file models
// ONE worker, so both activations share one slot space -- which is exactly the
// property the baseline records.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import { readForkResumeCatalog } from "../src/fork-resume-catalog";
import { ForkResumeTable, type ForkResumeSlots } from "../src/fork-resume-table";
import { buildVforkSideModuleFixture } from "./vfork-side-module-fixture";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const SYSROOT = process.env.KANDELO_TEST_SYSROOT ?? join(REPO_ROOT, "sysroot");

const BASELINE_DIR = join(
  REPO_ROOT,
  ".superpowers",
  "sdd",
  "2026-09-20-fork-resume-thunk-placement",
);
const BASELINE_PATH = join(BASELINE_DIR, "placement-baseline.json");

/**
 * Recording is OPT-IN, and that is the point.
 *
 * `.superpowers/` is gitignored, so this artifact does not travel with the
 * commit. If it goes missing, the honest outcome is a loud failure naming the
 * command that re-records it -- not a silent re-record, which after the
 * placement migration would quietly enshrine the NEW mapping as "the
 * baseline" and make the comparison this file exists for vacuous.
 */
const RECORD = process.env.KANDELO_RECORD_PLACEMENT_BASELINE === "1";

const PAGE = 65536;
const MODULE_BASE = 8 * 1024 * 1024;
const CHANNEL_BASE = 4 * PAGE;
const CATALOG_AT = 12 * 1024 * 1024;

/** Activation 0 is the main program; 1 is the side module it dlopens. */
const MAIN_ACTIVATION = 0;
const SIDE_ACTIVATION = 1;

const hasSysroot = existsSync(join(SYSROOT, "lib", "libc.a"));
if (process.env.KANDELO_REQUIRE_FORK_PLACEMENT_BASELINE === "1" && !hasSysroot) {
  throw new Error(
    "fork resume placement baseline was required but " +
      `${join(SYSROOT, "lib", "libc.a")} is missing; run scripts/build-musl.sh`,
  );
}

interface PlacementEntry {
  readonly ordinal: number;
  readonly slot: number;
}

interface PlacementBaseline {
  readonly fixture: string;
  /** Activation id (as a string key) to its ordinal -> slot mapping. */
  readonly activations: Record<string, readonly PlacementEntry[]>;
}

interface Harness {
  readonly table: ForkResumeTable;
  readonly seed: (activationId: number, ordinals: readonly number[]) => void;
  readonly errno: () => number;
}

/** The real module, its real table, and the host class that places into it. */
function harness(): Harness {
  const memory = new WebAssembly.Memory({
    initial: 256,
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
    label: "resume placement baseline",
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
  const slots: ForkResumeSlots = {
    resumeSlot: (activationId, functionOrdinal) => {
      const slot = resumeSlots(0, activationId, functionOrdinal);
      if (slot < 0) {
        throw new Error(
          `no slot for activation ${activationId} ordinal ${functionOrdinal} ` +
            `(errno ${errno()})`,
        );
      }
      return slot;
    },
    releaseResumeSlots: (activationId) => {
      const freed = resumeSlots(1, activationId, 0);
      if (freed < 0) {
        throw new Error(
          `activation ${activationId} had no slots to release (errno ${errno()})`,
        );
      }
      return freed;
    },
  };

  const table = new ForkResumeTable("resume placement baseline");
  // The MODULE's table, not one this test minted: it owns and exports it, so
  // binding anything else here would record a table nothing else can see.
  table.bindSlots(slots, x.__wpk_fork_resume_table as unknown as WebAssembly.Table);

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

  return { table, seed, errno };
}

/**
 * A fresh, distinct Wasm function per thunk.
 *
 * Distinct because the read-back matches funcref IDENTITY: two thunks that
 * were the same object would make two slots indistinguishable, and the
 * mapping would be a guess. The bytes are the minimal `(func)` module the
 * resume-table tests already use; placement never calls it.
 */
const THUNK_MODULE = new WebAssembly.Module(
  new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00,
    0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
  ]),
);

function mintThunk(): WebAssembly.ExportValue {
  return new WebAssembly.Instance(THUNK_MODULE).exports.f as WebAssembly.ExportValue;
}

/** The ordinals an SDK-built, fork-instrumented guest declares. */
function catalogOrdinals(wasmPath: string): readonly number[] {
  const module = new WebAssembly.Module(readFileSync(wasmPath));
  return readForkResumeCatalog(module).map((record) => record.functionOrdinal);
}

describe.skipIf(!hasSysroot)("fork resume-thunk placement baseline", () => {
  it("records where every activation's thunks land in the resume table", () => {
    const fixture = buildVforkSideModuleFixture();
    try {
      const catalogs = new Map<number, readonly number[]>([
        [MAIN_ACTIVATION, catalogOrdinals(fixture.programPath)],
        [SIDE_ACTIVATION, catalogOrdinals(fixture.libraryPath)],
      ]);
      // A fixture that yielded one empty catalog would record a baseline that
      // proves nothing about multi-activation placement, and would do it
      // silently. Two of the three stale fixture directories left in
      // `local-binaries/test-fixtures` are exactly that shape.
      for (const [activationId, ordinals] of catalogs) {
        expect(
          ordinals.length,
          `activation ${activationId} declares no resume targets`,
        ).toBeGreaterThan(0);
      }

      const h = harness();
      // Identity map, built as each thunk is minted: this is the ONLY record
      // of what was placed, and it is deliberately not the slot.
      const placed = new Map<
        WebAssembly.ExportValue,
        { activationId: number; ordinal: number }
      >();

      // Ascending activation id, which is the order a worker registers them:
      // the main program first, then each dlopen.
      for (const activationId of [MAIN_ACTIVATION, SIDE_ACTIVATION]) {
        const ordinals = catalogs.get(activationId)!;
        h.seed(activationId, ordinals);
        // THE PRODUCTION PLACEMENT PATH as of this commit. When placement
        // moves into the guest shim, this is the one call in this file that
        // changes; the seeding above, the read-back below and the recorded
        // artifact must not. If a later task finds itself editing anything
        // else here, the comparison has stopped being a comparison.
        h.table.registerActivation(
          activationId,
          ordinals.map((functionOrdinal) => {
            const thunk = mintThunk();
            placed.set(thunk, { activationId, ordinal: functionOrdinal });
            return { functionOrdinal, thunk };
          }),
        );
      }

      // READ BACK FROM THE TABLE. Every slot is examined, so a thunk placed
      // somewhere nobody asked for is found rather than missed.
      const table = h.table.resumeTable;
      const found = new Map<number, PlacementEntry[]>();
      let occupied = 0;
      for (let slot = 0; slot < table.length; slot++) {
        const entry = table.get(slot) as WebAssembly.ExportValue | null;
        if (entry === null) continue;
        occupied++;
        const origin = placed.get(entry);
        expect(origin, `slot ${slot} holds a funcref nothing placed`).toBeDefined();
        const list = found.get(origin!.activationId) ?? [];
        list.push({ ordinal: origin!.ordinal, slot });
        found.set(origin!.activationId, list);
      }

      // Slot 0 is the "no event" sentinel `resume_peek` returns, so no thunk
      // may ever live there.
      expect(table.get(0)).toBeNull();
      expect(occupied, "every minted thunk is in the table exactly once").toBe(
        placed.size,
      );

      const activations: Record<string, PlacementEntry[]> = {};
      for (const activationId of [...found.keys()].sort((a, b) => a - b)) {
        const entries = found
          .get(activationId)!
          .sort((left, right) => left.ordinal - right.ordinal);
        expect(
          entries.map((e) => e.ordinal),
          `activation ${activationId} placed every declared ordinal`,
        ).toEqual([...catalogs.get(activationId)!].sort((a, b) => a - b));
        activations[String(activationId)] = entries;
      }

      const baseline: PlacementBaseline = {
        fixture: "vfork-side-module (main program + dlopen'd side module)",
        activations,
      };

      if (RECORD || !existsSync(BASELINE_PATH)) {
        if (!RECORD) {
          throw new Error(
            `no recorded placement baseline at ${BASELINE_PATH}. It is ` +
              "gitignored, so a fresh worktree has none. Re-record it against " +
              "UNMODIFIED placement with " +
              "KANDELO_RECORD_PLACEMENT_BASELINE=1 npx vitest run " +
              "test/fork-resume-placement-baseline.test.ts -- recording it " +
              "against changed placement would make the comparison vacuous.",
          );
        }
        mkdirSync(BASELINE_DIR, { recursive: true });
        writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
        return;
      }

      const recorded = JSON.parse(
        readFileSync(BASELINE_PATH, "utf8"),
      ) as PlacementBaseline;
      // THE COMPARISON. A difference is a regression, not a new normal: do not
      // re-record to make this pass.
      expect(baseline).toEqual(recorded);
    } finally {
      fixture.cleanup();
    }
  });
});
