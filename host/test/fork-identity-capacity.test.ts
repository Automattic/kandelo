// The identity table must hold what the programs this repo builds actually need.
//
// An identity publication (`fm_publish_bindings`; `fm_set_identity_group`
// when this was written) stores one entry per `(space, activation, owner)`
// — that is, per `__wpk_fork_global_*` / `__wpk_fork_table_*` export, summed
// over EVERY activation in the worker. The module stores them in one static
// array, and overflow returns E2BIG, which surfaces as
//
//     fork-module: fm_set_identity_group failed with errno 7
//
// and kills the fork. The cap was 512. php.wasm alone exports 1,601 of these
// and intl.so exports 4,127, so `wordpress` and `lamp` — both of which load
// intl — could not fork at all. Nothing caught it because both packages were
// BLOCKED behind php's own build failure and had never run in this worktree.
//
// This test is the thing that would have caught it: it counts the exports in
// the shipped artifacts and requires the cap to cover them. It fails when a new
// extension pushes the real need past the bound, which is the moment to act,
// rather than at a fork in a package build an hour later.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A module's resume-catalog record count (KFRC header word at offset 8). Read
 * here, by a test, because the host no longer decodes the catalog: the fork
 * module does, at admission.
 */
function resumeCatalogCount(module: WebAssembly.Module): number {
  const [section] = WebAssembly.Module.customSections(module, "kandelo.wpk_fork.resume_catalog");
  if (!section) throw new Error("no kandelo.wpk_fork.resume_catalog section");
  return new DataView(section).getUint32(8, true);
}

import {
  WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX,
  WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX,
} from "../src/generated/abi";

const moduleSource = readFileSync(
  join(import.meta.dirname, "..", "..", "crates/fork-module/src/lib.rs"),
  "utf8",
);

/** Count catalog exports by scanning the export section's name bytes. */
function catalogExportCount(bytes: Uint8Array): number {
  // A name scan rather than a section walk: these prefixes are long and
  // distinctive, so counting their occurrences in the module's bytes is exact
  // enough for a capacity bound and cannot desync from a hand-written parser.
  const text = Buffer.from(bytes).toString("latin1");
  let total = 0;
  for (const prefix of [
    WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX,
    WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX,
  ]) {
    let at = text.indexOf(prefix);
    while (at !== -1) {
      total += 1;
      at = text.indexOf(prefix, at + prefix.length);
    }
  }
  return total;
}

/** Every php artifact this repo stages, if it has been built. */
function phpArtifacts(): { name: string; bytes: Uint8Array }[] {
  const roots = [
    join(import.meta.dirname, "..", "..", "local-binaries", "source-only-v1", "programs", "wasm32", "php"),
    join(import.meta.dirname, "..", "..", "local-binaries", "programs", "wasm32", "php"),
  ];
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    return readdirSync(dir)
      .filter((n) => n.endsWith(".wasm") || n.endsWith(".so"))
      .map((n) => ({ name: n, bytes: readFileSync(join(dir, n)) }));
  }
  return [];
}

/** Any `const NAME: usize = N;` the module declares, read from its source. */
function moduleCap(name: string): number {
  const match = new RegExp(`const ${name}: usize = ([0-9_]+);`).exec(moduleSource);
  if (!match) throw new Error(`fork-module no longer defines ${name}`);
  return Number(match[1].replace(/_/g, ""));
}

describe("fork-module fixed caps vs a real program", () => {
  // THE CLASS, not the instance. The identity table was one static sized for
  // programs nobody had measured; it is not the only one. Every cap below is a
  // single array shared by the WHOLE worker, so the number that matters is the
  // sum across every activation a process can hold at once -- which is what
  // `wordpress` and `lamp` proved by loading php plus intl and dying.
  //
  // Headroom is reported even when passing, because "passes today" and "has
  // room for one more extension" are different facts and only the second is
  // worth trusting.
  it("holds php's resume-catalog ordinals", () => {
    const artifacts = phpArtifacts();
    if (artifacts.length === 0) {
      console.warn(
        "fork-identity-capacity: php is not built, so the resume-catalog bound " +
          "was NOT checked. Build it to exercise this test.",
      );
      return;
    }

    // A PROCESS runs ONE main program plus the extensions it loads, so the
    // worst case is max(programs) + sum(extensions) -- NOT the sum of every
    // artifact. Summing them counts php.wasm AND php-fpm.wasm together, which
    // no process ever loads at once, and overstates the requirement by a whole
    // interpreter: 47,757 ordinals against a real per-process 28,568/28,732.
    let programMax = 0;
    let extensionTotal = 0;
    const per: string[] = [];
    for (const { name, bytes } of artifacts) {
      let count = 0;
      try {
        count = resumeCatalogCount(new WebAssembly.Module(bytes));
      } catch (error) {
        // ONLY "this module has no catalog section" may be treated as zero. A
        // ReferenceError or TypeError here is a bug in this test, and a broad
        // `catch { continue }` turns it into "contributes nothing" -- which is
        // how both of these assertions first shipped as `0 <= cap`, passing
        // while the module's cap was cut below php's real need. Re-throw
        // anything that is not the expected shape.
        if (error instanceof RangeError || error instanceof WebAssembly.CompileError) {
          continue; // not a wasm module we can read
        }
        if (!(error instanceof Error) || !/section/i.test(error.message)) {
          throw error;
        }
        continue; // fork-instrumented modules only; others contribute nothing
      }
      if (name.endsWith(".so")) extensionTotal += count;
      else programMax = Math.max(programMax, count);
      per.push(`${name}=${count}`);
    }
    const total = programMax + extensionTotal;
    // THERE IS NO CATALOG CAP LEFT TO HOLD. `RESUME_CATALOG_CAP` (the
    // process-wide static) and `ACTIVATION_CATALOG_ORD_FLOOR` (the shared
    // floor) are both gone: every catalog is an arena record sized to the
    // request, and a record larger than a chunk gets a chunk sized to hold it
    // (`arena_map_chunk`). What this test pins now is the claim that comment
    // makes -- that the oversized-chunk path is production, not a forced-build
    // curiosity, because php's MAIN activation alone needs more than one
    // 64 KiB chunk's body holds. If php ever shrank under that, the comment
    // would be wrong and this says so.
    const ARENA_CHUNK_BODY = 65_536 - 32;
    expect(
      programMax * 4,
      `php's largest single catalog is ${programMax} ordinals (${programMax * 4} ` +
        `bytes), which the arena's oversized-chunk path is documented to serve on ` +
        `every php start. Per-process need: ${total}. Per-artifact: ${per.join(" ")}`,
    ).toBeGreaterThan(ARENA_CHUNK_BODY);
  });

  it("holds php's activation count", () => {
    const artifacts = phpArtifacts();
    if (artifacts.length === 0) return;
    // One activation per fork-instrumented module a process can hold at once.
    const acts = artifacts.filter(({ bytes }) => {
      try {
        resumeCatalogCount(new WebAssembly.Module(bytes));
        return true;
      } catch (error) {
        if (error instanceof RangeError || error instanceof WebAssembly.CompileError) {
          return false;
        }
        if (!(error instanceof Error) || !/section/i.test(error.message)) {
          throw error;
        }
        return false;
      }
    }).length;
    // THERE IS NO PER-ACTIVATION CAP LEFT TO HOLD. `ACTIVATION_CATALOG_MAX_
    // ACTS`, `ACT_GC_CODEC_MAX_ACTS`, `ACT_EXN_TAGS_MAX_ACTS`, and then
    // `TEMPLATE_ID_MAX_ACTS`, `STATIC_ROOT_BASE_MAX_ACTS` and
    // `FUNC_CATALOG_BASE_MAX_ACTS` all went with their stores: each is one
    // arena record per activation now, released with it, and the arena has
    // no activation count to exceed. What this pins is that none of them
    // comes back -- the same shape as the identity-cap assertion below --
    // while still measuring php's activation count so the number stays in
    // front of a reader.
    expect(acts, "php holds at least one fork-instrumented activation").toBeGreaterThan(0);
    for (const cap of [
      "TEMPLATE_ID_MAX_ACTS",
      "STATIC_ROOT_BASE_MAX_ACTS",
      "FUNC_CATALOG_BASE_MAX_ACTS",
      "TABLE_STATE_OWNER_MAX",
      "IMPORTED_GLOBAL_PROVENANCE_MAX",
    ]) {
      expect(
        moduleSource,
        `${cap} is back in crates/fork-module/src/lib.rs. A fixed per-worker ` +
          `cap is billed to every fork-capable thread and was never released ` +
          `by dlclose; php holds ${acts} activations today and the arena ` +
          `holds any number. Put the store on the arena instead.`,
      ).not.toMatch(new RegExp(`const ${cap}: usize`));
    }
  });
});

describe("fork-module identity table capacity", () => {
  it("has no fixed identity cap to exceed", () => {
    // WHAT THIS REPLACED, and why the shape changed. This test used to assert
    // php's measured need (7,684 entries) against `GLOBAL_IDENTITY_MAX`, and it
    // did its job: it is how the E2BIG that blocked wordpress and lamp was
    // found, and raising the cap to 16,384 is what made them build.
    //
    // But a cap that is large enough for php is also 256 KiB of the module's
    // `dylink` static, and the host mmaps that whole region out of the GUEST's
    // window before the guest allocates anything. That broke P-11, whose
    // process is deliberately capped at 384 pages. Measured then: 16,384 left
    // 2.0 pages of window and P-11 failed; 512 left 5.0 and it passed. There
    // was no value that satisfied both -- the viable range topped out around
    // 9,216 against a need of 7,684.
    //
    // So the bound is gone rather than retuned. Identity entries live in chunks
    // the module `SYS_MMAP`s when it needs one and `SYS_MUNMAP`s when a dlclose
    // empties one. Nothing is reserved, so there is no number to compare a
    // program against, and this assertion guards the one thing that could
    // silently come back: a static bound reappearing in the source.
    expect(
      moduleSource,
      "a fixed identity cap is back in crates/fork-module/src/lib.rs. It cannot " +
        "be sized: too small refuses php (7,684 entries), and large enough for " +
        "php takes 256 KiB out of every guest's mmap window, which is what broke " +
        "P-11. Allocate chunks on demand instead.",
    ).not.toMatch(/const GLOBAL_IDENTITY_MAX/);
  });

  it("still measures what php would need, as scale rather than a bound", () => {
    const artifacts = phpArtifacts();
    if (artifacts.length === 0) {
      console.warn(
        "fork-identity-capacity: php is not built in this tree, so its identity " +
          "scale was NOT measured. Build it to exercise this test.",
      );
      return;
    }
    // Kept because the NUMBER is still worth having in front of a reader, even
    // with nothing to compare it to: it is what makes "on demand" concrete, and
    // it is the figure any future bound would have to answer to.
    const need = artifacts.reduce((sum, a) => sum + catalogExportCount(a.bytes), 0);
    const per = artifacts
      .map((a) => `${a.name}=${catalogExportCount(a.bytes)}`)
      .join(" ");
    expect(need, `php identity entries: ${per}`).toBeGreaterThan(0);
    // One 64 KiB chunk holds 4,095 entries, so php spans a handful. A change
    // that made this need hundreds of chunks would be worth noticing.
    expect(Math.ceil(need / 4095), `php spans chunks; per-artifact: ${per}`)
      .toBeLessThan(16);
  });
});
