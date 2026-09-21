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

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import { readForkResumeCatalog } from "../src/fork-resume-catalog";
import { ForkResumeTable, type ForkResumeSlots } from "../src/fork-resume-table";
import { artifactGate } from "./support/artifact-gate";
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

/**
 * The shared gate, not a bespoke one.
 *
 * This file builds its guests with the SDK, so a worktree without a sysroot
 * cannot run it. A plain `describe.skipIf` would print nothing and exit 0,
 * and a Task 4 run in that worktree would report "placement matches the
 * baseline" having compared nothing -- the vacuous green this whole file
 * exists to prevent. `artifactGate` announces the skip by default and turns
 * it into a failure under the repo-standard `KANDELO_REQUIRE_E2E=1`, which is
 * what a run whose result is being used as evidence should set.
 */
const { skip } = artifactGate("fork resume-thunk placement baseline", [
  {
    what: `${join(SYSROOT, "lib", "libc.a")} (SDK sysroot)`,
    present: existsSync(join(SYSROOT, "lib", "libc.a")),
    build: "scripts/dev-shell.sh scripts/build-musl.sh",
  },
]);

interface PlacementEntry {
  readonly ordinal: number;
  readonly slot: number;
}

/**
 * sha256 of the two guest binaries the ordinals were read out of.
 *
 * WHY: the ordinals come from SDK-built, fork-instrumented guests, so a change
 * anywhere in `libc/`, `sdk/` or `crates/fork-instrument/` moves the KFRC
 * ordinal set and reddens the mapping comparison with a diff that reads
 * exactly like a placement regression. Recorded so the mismatch can name
 * itself instead of costing someone an afternoon.
 */
interface FixtureFingerprint {
  readonly program: string;
  readonly library: string;
}

interface PlacementBaseline {
  readonly fixture: string;
  readonly fixtureFingerprint: FixtureFingerprint;
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
  // OP 0, AND THE SECOND OP-0 COUPLING IN THIS FILE. This one is load-bearing
  // and cannot be removed: `ForkResumeTable.registerActivation` -- the
  // production placement path being characterized -- asks a `ForkResumeSlots`
  // for every slot it writes, and op 0 is that query today. The read-back
  // below deliberately does NOT use it.
  //
  // Task 6 of this plan deletes the op-0 arm, which will break this harness.
  // That is expected: this is the BEFORE recorder. Task 6's caller grep was
  // blind to `host/test` and so could not see this hit; `a99a3a2d8` widened
  // its search path to cover this directory.
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

/** sha256 of a file, for the fixture fingerprint. */
function fileDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe.skipIf(skip)("fork resume-thunk placement baseline", () => {
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
        // THE PRODUCTION PLACEMENT PATH as of this commit, and the whole of
        // what this file can characterize.
        //
        // WHAT THIS FILE CANNOT DO, said plainly so nobody plans around it:
        // it never INSTANTIATES either guest. It reads their custom sections
        // and mints stand-in thunks. So the guest-side placement shim Task 2
        // adds -- `__wpk_fork_place_resume_thunks`, a guest EXPORT that reads
        // the guest's own catalog table -- can never be driven from here.
        // Swapping this one call for that export is not possible; it would
        // need a live instance of an SDK-linked program, with the kandelo
        // import object and a syscall channel, which is precisely the
        // in-process instantiation this file exists to avoid.
        //
        // CONTROLLER RULING: Task 4 produces the AFTER half by seeding these
        // same two catalogs and calling `fm_publish_resume_assignment`
        // (Task 3), decoding its `(ordinal, slot)` pairs and diffing them
        // against the SAME recorded artifact. That compares the thing which
        // actually decides placement, and needs no guest instance. The
        // artifact's shape is therefore the stable contract between the two
        // halves -- not any line in this file.
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
        fixtureFingerprint: {
          program: fileDigest(fixture.programPath),
          library: fileDigest(fixture.libraryPath),
        },
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

      // FIRST, and with its own message: did the INPUTS move? A toolchain
      // change under `libc/`, `sdk/` or `crates/fork-instrument/` gives the
      // guests a different ordinal set, and the mapping diff that follows
      // would look identical to a placement regression while meaning nothing
      // of the sort. Fail here instead, saying which it is.
      if (
        baseline.fixtureFingerprint.program !== recorded.fixtureFingerprint?.program
        || baseline.fixtureFingerprint.library !== recorded.fixtureFingerprint?.library
      ) {
        throw new Error(
          "the fixture binaries changed; this is NOT a placement regression. " +
            "The recorded baseline was taken against different guest wasm " +
            `(program ${recorded.fixtureFingerprint?.program ?? "<absent>"}, ` +
            `library ${recorded.fixtureFingerprint?.library ?? "<absent>"}) ` +
            `than this run built (program ${baseline.fixtureFingerprint.program}, ` +
            `library ${baseline.fixtureFingerprint.library}). Something under ` +
            "libc/, sdk/ or crates/fork-instrument/ moved. Re-record against " +
            "UNMODIFIED placement before comparing: " +
            "KANDELO_RECORD_PLACEMENT_BASELINE=1 npx vitest run " +
            "test/fork-resume-placement-baseline.test.ts",
        );
      }

      // THEN THE COMPARISON. A difference is a regression, not a new normal:
      // do not re-record to make this pass.
      expect(baseline).toEqual(recorded);
    } finally {
      fixture.cleanup();
    }
  });
});
