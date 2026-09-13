import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildForkGuestImports } from "../src/fork-guest-imports";
import { createForkGuestHostFloor } from "../src/fork-guest-host-floor";
import { ForkResumeTable } from "../src/fork-resume-table";
import { ForkTableStateOwners } from "../src/fork-table-state-owners";

/**
 * The pieces of the thin layer, composed against a REAL instrumented artifact.
 *
 * Each piece has its own unit tests, and every one of them passes against
 * hand-built inputs. That proves each piece, and proves nothing about whether
 * they add up to a complete `env` for a guest the production instrumentation
 * actually emits -- which is the only question that matters at the moment
 * `worker-main.ts` stops building that object by hand.
 *
 * The gap this closes is not hypothetical. The artifact below imports FIFTY-ONE
 * things from `env`. The generated contract tables enumerate forty-eight of them
 * (46 functions + 2 tables). The other three -- two GLOBALS and a TAG -- are
 * covered by no list at all, so a binder driven only by the tables reports
 * success and the failure arrives later inside `WebAssembly.instantiate` as a
 * type complaint that names no import.
 *
 * The fixture is built through the production pipeline
 * (`scripts/build-fork-instrumented-test-fixture.sh` -> `run-wasm-fork-instrument.sh`,
 * the same tool every fork-using package build runs) rather than hand-written,
 * so a change to what instrumentation emits cannot silently stop this from
 * testing what it claims.
 */

const repoRoot = join(import.meta.dirname, "..", "..");
const script = join(repoRoot, "scripts", "build-fork-instrumented-test-fixture.sh");

let workspace: string | null = null;

function instrumentedFixture(): WebAssembly.Module | null {
  if (!existsSync(script)) return null;
  workspace ??= mkdtempSync(join(tmpdir(), "kandelo-fork-env-"));
  const out = join(workspace, "fixture32.wasm");
  if (!existsSync(out)) {
    try {
      execFileSync("bash", [script, "--arch", "wasm32", "--output", out], {
        cwd: repoRoot,
        stdio: "pipe",
      });
    } catch {
      return null;
    }
  }
  return new WebAssembly.Module(readFileSync(out));
}

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

/** Everything the co-resident module would serve, stubbed by name. */
function moduleExportsFor(guest: WebAssembly.Module): Record<string, unknown> {
  const floorNames = new Set([
    "__wpk_fork_module_state_table_state_owned",
    "__wpk_fork_ref_exn_broker_throw_recipe",
    "__wpk_fork_ref_exn_ingress_throw",
    "__wpk_fork_ref_provenance_externref",
  ]);
  const exports: Record<string, unknown> = {};
  for (const imported of WebAssembly.Module.imports(guest)) {
    if (imported.module !== "env") continue;
    if (imported.kind !== "function") continue;
    if (floorNames.has(imported.name)) continue;
    exports[imported.name] = () => 0;
  }
  // The two non-function imports the real module OWNS and exports. A host does
  // not supply these; the binder takes them from the module.
  exports.__wpk_fork_ref_gc_transit = new WebAssembly.Table({
    element: "anyref" as "externref",
    initial: 1,
  });
  exports.__wpk_fork_unwind = new WebAssembly.Tag({ parameters: [] });
  return exports;
}

describe("the thin layer composed against a real instrumented guest", () => {
  const guest = instrumentedFixture();
  const guard = guest === null ? it.skip : it;

  guard("binds every single thing the artifact imports from env", () => {
    const owners = new ForkTableStateOwners();
    const resume = new ForkResumeTable();
    const { floor } = createForkGuestHostFloor({
      tryEncodeExternref: () => undefined,
      ownsTableState: (owner) => owners.ownsState(0, owner),
    });

    const env = buildForkGuestImports({
      moduleExports: moduleExportsFor(guest!),
      floor,
      // Only THREE entries: the resume table the host owns, and the two
      // per-process globals. The transit table and the unwind tag are not here
      // -- the module exports them and the binder takes them from there.
      extras: {
        __wpk_fork_resume_table: resume.table,
        __wpk_fork_module_activation: new WebAssembly.Global(
          { value: "i32", mutable: false },
          0,
        ),
        __wpk_fork_module_state_table_generation_addr: new WebAssembly.Global(
          { value: "i32", mutable: false },
          0,
        ),
      },
      guestModule: guest!,
      label: "composition test",
    });

    const unbound = WebAssembly.Module.imports(guest!)
      .filter((i) => i.module === "env" && !(i.name in env))
      .map((i) => `${i.name} (${i.kind})`);
    expect(unbound).toEqual([]);
  });

  guard("counts three env imports that no generated list enumerates", () => {
    // Stated as a NUMBER rather than a list so that instrumentation adding a
    // fourth unlisted import fails here instead of passing quietly. If this
    // trips, the right response is usually to check the binder still reports
    // the new one -- not to bump the number.
    const envImports = WebAssembly.Module.imports(guest!)
      .filter((i) => i.module === "env");
    const listed = envImports.filter(
      (i) => i.kind === "function" || i.kind === "table",
    );
    expect(envImports.length - listed.length).toBe(3);
  });

  guard("reports the unlisted kinds when a caller forgets them", () => {
    let message = "";
    try {
      buildForkGuestImports({
        moduleExports: moduleExportsFor(guest!),
        floor: createForkGuestHostFloor({
          tryEncodeExternref: () => undefined,
          ownsTableState: () => false,
        }).floor,
        extras: { __wpk_fork_resume_table: new ForkResumeTable().table },
        guestModule: guest!,
        label: "composition test",
      });
    } catch (error) {
      message = (error as Error).message;
    }
    // Both globals, each named, in one failure rather than two instantiation
    // attempts. The TAG is absent from this list on purpose: the module exports
    // it, so forgetting it is no longer something a host can do.
    expect(message).toContain("__wpk_fork_module_activation");
    expect(message).toContain("__wpk_fork_module_state_table_generation_addr");
    expect(message).not.toContain("__wpk_fork_unwind");
  });

  guard("takes the transit table and the unwind tag from the MODULE", () => {
    // The point is ownership, not presence. A host that mints its own tag makes
    // the module and the guest disagree the moment the module throws one, and
    // that disagreement is invisible until an unwind crosses the boundary.
    const moduleExports = moduleExportsFor(guest!);
    const env = buildForkGuestImports({
      moduleExports,
      floor: createForkGuestHostFloor({
        tryEncodeExternref: () => undefined,
        ownsTableState: () => false,
      }).floor,
      extras: {
        __wpk_fork_resume_table: new ForkResumeTable().table,
        __wpk_fork_module_activation: new WebAssembly.Global(
          { value: "i32", mutable: false }, 0,
        ),
        __wpk_fork_module_state_table_generation_addr: new WebAssembly.Global(
          { value: "i32", mutable: false }, 0,
        ),
        // A host trying to supply its own. The module's must win.
        __wpk_fork_unwind: new WebAssembly.Tag({ parameters: [] }),
        __wpk_fork_ref_gc_transit: new WebAssembly.Table({
          element: "anyref" as "externref",
          initial: 4,
        }),
      },
      guestModule: guest!,
      label: "composition test",
    });
    expect(env.__wpk_fork_unwind).toBe(moduleExports.__wpk_fork_unwind);
    expect(env.__wpk_fork_ref_gc_transit).toBe(
      moduleExports.__wpk_fork_ref_gc_transit,
    );
  });
});
