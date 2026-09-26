import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FORK_IMPORT_SPACE_TABLE, ForkImportIdentity } from "../src/fork-import-identity";
import { ForkModuleContinuationBackend } from "../src/fork-module-backend";
import { ForkTables } from "../src/fork-tables";
import {
  ARENA_STAGING_AT,
  arenaFixture,
  CHANNEL_BASE,
  type ArenaFixture,
} from "./fork-module-capture-fixture";
import { exportRow, publishBindings } from "./support/fork-admission";

/**
 * WHO WRITES A SHARED TABLE'S SPARSE STATE, decided by the fork module.
 *
 * Two activations that import one `WebAssembly.Table` each export it as their
 * own `__wpk_fork_table_<owner>` catalog entry, so one physical table has two
 * `(activation, owner)` coordinates. Exactly one may write its sparse state at
 * capture; the other still journals mutations. The HOST used to elect that
 * coordinate (`ForkTableStateOwners`) and tell the module the answer. Since
 * lane F stage 1H the host only says which identity group each catalog table
 * is (`fm_publish_bindings`), and the module elects: the LOWEST coordinate of
 * the group, re-elected when a coordinate is published and when an activation
 * is `dlclose`d.
 *
 * This drives that through the production classes the Node and browser hosts
 * run -- `ForkImportIdentity` walking real instances, the backend's row
 * writer, `ForkTables` marking a host mutation by group -- against the real
 * fork module. The pure election (lowest coordinate, demotions before the
 * promotion) is `fork_codec::bindings::table_state_election`, unit-tested in
 * `crates/fork-codec`.
 */

function compile(wat: string): WebAssembly.Module {
  const directory = mkdtempSync(join(tmpdir(), "fork-table-state-election-"));
  try {
    writeFileSync(join(directory, "a.wat"), wat);
    execFileSync("wat2wasm", [join(directory, "a.wat"), "-o", join(directory, "a.wasm")]);
    return new WebAssembly.Module(readFileSync(join(directory, "a.wasm")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** An activation that imports `env.tbl` and exports it as catalog `owner`. */
function aliasing(owner: number): WebAssembly.Module {
  return compile(`(module
    (import "env" "tbl" (table 1 funcref))
    (export "__wpk_fork_table_${owner}" (table 0)))`);
}

/** An activation with a private table of its own, as catalog `owner`. */
function owning(owner: number): WebAssembly.Module {
  return compile(`(module
    (table 1 funcref)
    (export "__wpk_fork_table_${owner}" (table 0)))`);
}

function rig(): {
  f: ArenaFixture;
  identity: ForkImportIdentity;
  tables: ForkTables;
  backend: ForkModuleContinuationBackend;
  instantiate: (activation: number, module: WebAssembly.Module, tbl?: WebAssembly.Table) => void;
  owned: (activation: number, owner: number) => number;
  dirtyPages: (owner: number) => number;
} {
  const f = arenaFixture("table-state election");
  const backend = new ForkModuleContinuationBackend({
    instance: f.instance,
    memory: f.memory,
    ptrWidth: 4,
    channelBase: CHANNEL_BASE,
    label: "table-state election",
  });
  const mark = f.x.__wpk_fork_module_state_table_dirty_mark as (o: number, p: bigint, n: bigint) => void;
  const tables = new ForkTables({ markTablePages: (group, first, count) => mark(group, first, count) }, "test");
  const identity = new ForkImportIdentity(backend, "test", tables);
  return {
    f,
    identity,
    tables,
    backend,
    instantiate: (activation, module, tbl) => {
      const imports = tbl ? { env: { tbl } } : {};
      const prepared = identity.prepareActivation(activation, module, imports);
      prepared.complete(new WebAssembly.Instance(module, prepared.imports as WebAssembly.Imports));
    },
    owned: (activation, owner) => f.tableStateOwned(activation, owner),
    dirtyPages: (owner) =>
      (f.x.__wpk_fork_module_state_table_dirty_count as (o: number) => number)(owner),
  };
}

describe("the fork module elects a shared table's writer", () => {
  it("elects the lowest coordinate, not the first published, and re-elects on dlclose", () => {
    const r = rig();
    const shared = new WebAssembly.Table({ element: "anyfunc", initial: 2048 });
    // A private table of activation 0: its own group, untouched throughout.
    r.instantiate(0, owning(1));
    // The HIGHER activation publishes first. "First wins" would keep it.
    r.instantiate(4, aliasing(5), shared);
    expect(r.owned(4, 5), "alone in its group, activation 4 owns it").toBe(1);
    r.instantiate(2, aliasing(3), shared);
    expect(r.owned(2, 3), "the lower coordinate is canonical").toBe(1);
    expect(r.owned(4, 5), "and the incumbent is demoted").toBe(0);
    expect(r.owned(0, 1), "a separate table is its own group").toBe(1);

    // A host mutation of the shared table is journaled under the ELECTED
    // coordinate's owner, which the host never learns: it marks by group.
    // Publishing the incumbent again (a re-registration) keeps it.
    r.instantiate(2, aliasing(3), shared);
    expect([r.owned(2, 3), r.owned(4, 5)], "an unchanged election stays put").toEqual([1, 0]);

    r.tables.markTableMutation(shared, 1023, 2); // pages 0 and 1
    expect(r.f.errno(), "the group resolves").toBe(0);
    expect(r.dirtyPages(3), "marked under the elected owner").toBe(2);
    expect(r.dirtyPages(5), "not under the alias").toBe(0);

    // dlclose of the canonical coordinate's activation. The survivor must be
    // promoted, or the table has no writer and its state stops reaching a
    // child without anything trapping.
    r.backend.releaseResumeSlots(2);
    expect(r.owned(4, 5), "the release re-elects the survivor").toBe(1);
    expect(r.owned(2, 3), "the released coordinate is gone").toBe(0);
    r.tables.markTableMutation(shared, 0, 1);
    expect(r.dirtyPages(5), "a later mark follows the new writer").toBe(1);

    // Re-opening at the old id is a fresh, lower coordinate again.
    r.instantiate(2, aliasing(3), shared);
    expect([r.owned(2, 3), r.owned(4, 5)], "the reopened lower coordinate wins").toEqual([1, 0]);
  });

  it("breaks an activation tie by owner", () => {
    // One activation exporting a shared table under two catalog owners is the
    // degenerate alias; the lower owner writes.
    const r = rig();
    const shared = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
    const twice = compile(`(module
      (import "env" "tbl" (table 1 funcref))
      (export "__wpk_fork_table_7" (table 0))
      (export "__wpk_fork_table_2" (table 0)))`);
    r.instantiate(1, twice, shared);
    expect([r.owned(1, 2), r.owned(1, 7)]).toEqual([1, 0]);
  });

  it("refuses a malformed publication whole, storing none of it", () => {
    // Every row is checked before any is stored. A half-stored publication
    // would elect over coordinates the host never finished describing.
    const r = rig();
    const errno = publishBindings(r.f.x, r.f.memory, ARENA_STAGING_AT, 6, [
      exportRow(FORK_IMPORT_SPACE_TABLE, 1, 40),
      exportRow(FORK_IMPORT_SPACE_TABLE, 0, 40), // owner 0 names no catalog table
    ]);
    expect(errno).toBe(22);
    expect(r.owned(6, 1), "the valid row was not stored either").toBe(0);
  });

  it("takes every page as dirty when a marked group has no writer left", () => {
    // Every coordinate of the table was released, but the host still holds
    // the Table and marks it. Nothing can say whose pages those are, so the
    // module over-approximates -- the one direction that cannot rebuild a
    // child wrong -- and says why.
    const r = rig();
    const shared = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
    r.instantiate(3, aliasing(1), shared);
    r.backend.releaseResumeSlots(3);
    r.tables.markTableMutation(shared, 0, 1);
    expect(r.f.errno(), "the unattributable mark is reported").toBe(22);
    expect(r.dirtyPages(9), "and every page of every table reads dirty").toBe(4096);
  });
});
