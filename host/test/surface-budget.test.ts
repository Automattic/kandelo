import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { findRepoRoot } from "../src/binary-tiers";

/**
 * The campaign's surfaces are ratcheted, not merely documented.
 *
 * # Why this test exists
 *
 * This campaign produced 132 plan documents and exactly one mechanism that
 * nothing ever escaped: `EXPECTED_HOST_IMPORT_COUNT` — a number in the
 * repository asserted against a measurement of the built artifact. Every
 * import change hit it, including two independent reductions that composed
 * correctly *only* because both measured rather than quoting the pin.
 *
 * Over the same period fork TypeScript grew by 2,867 lines, against a contract
 * saying it "shrinks toward the floor over time; it does not grow" — and
 * nobody noticed for weeks, because nothing measured it. That is the whole
 * argument: a document is advisory, and a number a test asserts is not.
 *
 * # Why it fails in BOTH directions
 *
 * Exceeding a ceiling fails: the surface grew. Falling well below one also
 * fails, asking for the ceiling to be lowered in the same commit. The second
 * half is what banks a reduction — without it, one lane's deletion silently
 * funds the next lane's growth, which is close to what happened here: the JS
 * fork twin was deleted (−4,643) in an earlier phase while the dedicated fork
 * files grew by nearly as much, and the two were never compared.
 *
 * # What this test is not
 *
 * It is not a quality measure. Line counts are a proxy, and a poor one for
 * anything except "is this surface getting bigger or smaller". The `target`
 * field in the budget is the campaign's goal and is deliberately far below
 * every ceiling; the gap between them is the remaining work, not slack.
 */

interface ClosureCondition {
  surface: string;
  atMost: number;
}

interface Lane {
  title: string;
  status: "open" | "closed" | "deferred";
  closure: ClosureCondition[] | "manual" | "checklist";
  checklist?: Record<string, boolean>;
  why: string;
}

interface Surface {
  measure: string;
  ceiling: number;
  slack: number;
  target: number;
  why: string;
}

const repoRoot = findRepoRoot();

function readBudget(): { surfaces: Record<string, Surface>; lanes: Record<string, Lane> } {
  const raw = readFileSync(join(repoRoot, "docs", "surface-budget.json"), "utf8");
  return JSON.parse(raw) as {
    surfaces: Record<string, Surface>;
    lanes: Record<string, Lane>;
  };
}

function budget(): Record<string, Surface> {
  return readBudget().surfaces;
}

/**
 * Count CODE lines across a shell glob, resolved from the repo root: lines that
 * are neither blank nor purely a comment.
 *
 * # Why this is not `wc -l`
 *
 * It was, and counting every line made these ceilings measure the wrong thing.
 * The surfaces below exist to stop TypeScript IMPLEMENTATION growing, because
 * the campaign's goal is to move implementation into Rust and the fork-module.
 * A total-line ceiling cannot tell an added function from an added paragraph of
 * explanation, so it fails a commit that deletes code and documents why.
 *
 * That is not hypothetical. Lane F's `fm_capture_intern` collapse removed four
 * per-type module exports and three host marshalling wrappers -- fork
 * TypeScript CODE fell 5 lines -- and the total-line gate failed it, because the
 * commit also explained the collapse in 20 lines of comment. The author's first
 * response was to compress the explanation until the number went down, which is
 * the metric shaping the code instead of measuring it.
 *
 * So the measure counts code and the ceilings are stated in code lines. A
 * comment now costs nothing, which is the intended incentive: this campaign
 * repeatedly finds that the expensive defects are the ones nobody wrote down.
 *
 * # What it counts
 *
 * A scanner, not a regex, because `//` and `/*` appear inside string and
 * template literals and a regex strips those too. It tracks single-quote,
 * double-quote and template-literal state, so a line whose only content is a
 * comment is excluded and a line of code carrying a trailing comment is not.
 * Nested template substitutions are not tracked; a `${...}` containing a quote
 * character is the known limit, and it costs at most a line either way.
 */
function codeLineCount(globs: string[]): number {
  // `|| true`: a glob matching nothing makes `ls` exit non-zero, and
  // execFileSync THROWS on a non-zero exit -- so a surface that reaches zero
  // would fail its own measurement instead of reporting 0. An empty surface is
  // the goal state for several of these, so it has to be measurable.
  const listed = execFileSync(
    "/bin/sh",
    ["-c", `ls ${globs.join(" ")} 2>/dev/null || true`],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .split("\n")
    .filter((f) => f.length > 0);
  let total = 0;
  for (const rel of listed) {
    total += codeLinesInSource(readFileSync(join(repoRoot, rel), "utf8"));
  }
  return total;
}

/** @internal Exported shape kept simple so the scanner itself is testable. */
function codeLinesInSource(source: string): number {
  let inBlockComment = false;
  let count = 0;
  for (const line of source.split("\n")) {
    let sawCode = false;
    let quote: string | null = null;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      const next = line[i + 1];
      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          i += 1;
        }
        continue;
      }
      if (quote !== null) {
        sawCode = true;
        if (ch === "\\") {
          i += 1;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === "/" && next === "/") {
        break; // line comment: nothing after it counts
      }
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        sawCode = true;
        continue;
      }
      if (!/\s/.test(ch)) {
        sawCode = true;
      }
    }
    if (sawCode) {
      count += 1;
    }
  }
  return count;
}

function countMatches(relPath: string, pattern: RegExp): number {
  const text = readFileSync(join(repoRoot, relPath), "utf8");
  return text.split("\n").filter((line) => pattern.test(line)).length;
}

const MEASURED: Record<string, () => number> = {
  // Split by purpose 2026-09-12: the module-facing half is DONE and banked at
  // its measurement, the platform half is unstarted. One ceiling over both
  // mixes a finished population with an empty one and cannot be read — the same
  // reason `forkModuleEntryPoints` was split into three.
  // The glob catches the module-facing files by name; `fork-reference-capture-module`
  // is module-facing too -- "a thin, stateful wrapper over the `fm_capture_*`
  // exports of ONE resident fork-module instance" -- and is named here because
  // its filename does not start with `fork-module-`. Leaving it to the
  // `fork-*.ts` sweep would file it under `forkRestoredHostFloor`, a surface
  // defined as process lifecycle, cross-worker transport or memory placement
  // RATHER THAN capture/replay logic, which it is.
  forkTypeScript: () =>
    codeLineCount([
      "host/src/fork-module-*.ts",
      "host/src/fork-reference-capture-module.ts",
    ]),
  // The thin layer this lane AUTHORS, listed file by file rather than globbed.
  //
  // A glob over `host/src/fork-*.ts` used to define this, which was right while
  // every other fork file sat in the attic and wrong the moment any came back:
  // it then measured newly written code and restored host floor as one number,
  // which is the population mixing the maintainer had `forkModuleEntryPoints`
  // split for. Naming the files keeps this surface about what it was set up to
  // bound, and makes adding a file to it a visible decision.
  forkPlatformTypeScript: () =>
    codeLineCount([
      "host/src/fork-guest-imports.ts",
      "host/src/fork-guest-host-floor.ts",
      "host/src/fork-mechanism-trace.ts",
      "host/src/fork-anyref-transit.ts",
      "host/src/fork-table-state-owners.ts",
      "host/src/fork-resume-table.ts",
      "host/src/fork-phase.ts",
    ]),
  // Host floor restored from the attic: everything the `fork-*.ts` sweep took by
  // FILENAME that turned out to be process lifecycle, cross-worker transport or
  // memory placement rather than fork capture/replay logic.
  forkRestoredHostFloor: () =>
    codeLineCount(["host/src/fork-*.ts", "host/src/vfork-*.ts"]) -
    codeLineCount([
      "host/src/fork-module-*.ts",
      "host/src/fork-reference-capture-module.ts",
      "host/src/fork-guest-imports.ts",
      "host/src/fork-guest-host-floor.ts",
      "host/src/fork-mechanism-trace.ts",
      "host/src/fork-anyref-transit.ts",
      "host/src/fork-table-state-owners.ts",
      "host/src/fork-resume-table.ts",
      "host/src/fork-phase.ts",
    ]),
  workerMainTypeScript: () => codeLineCount(["host/src/worker-main.ts"]),
  sffsTypeScript: () => codeLineCount(["host/src/vfs/sharedfs-vendor.ts"]),
  hostImportFunctions: () =>
    Number.parseInt(
      /EXPECTED_HOST_IMPORT_COUNT: usize = (\d+)/.exec(
        readFileSync(join(repoRoot, "crates/host-native/src/lib.rs"), "utf8"),
      )?.[1] ?? "-1",
      10,
    ),
  // The fork-module is a SEPARATE artifact with its own imports, every one of
  // which a host must satisfy. `hostImportFunctions` above covers only the
  // kernel, so this half of the host obligation had no gate at all until
  // 2026-09-12. Read from the same constant the host-native test asserts
  // against every fork-module artifact on disk, so this number cannot drift
  // from the built bytes.
  forkModuleHostImports: () =>
    Number.parseInt(
      /EXPECTED_FORK_MODULE_HOST_IMPORT_COUNT: usize = (\d+)/.exec(
        readFileSync(join(repoRoot, "crates/host-native/src/lib.rs"), "utf8"),
      )?.[1] ?? "-1",
      10,
    ),
  memoryFsTypeScript: () => codeLineCount(["host/src/vfs/memory-fs.ts"]),
  kernelWorkerTypeScript: () => codeLineCount(["host/src/kernel-worker.ts"]),
  // 91.6% of kernel-worker.ts is one class. A line gate alone permits
  // shuffling code between methods of the same god class; this does not.
  kernelWorkerClassMethods: () => {
    const lines = readFileSync(
      join(repoRoot, "host/src/kernel-worker.ts"),
      "utf8",
    ).split("\n");
    const start = lines.findIndex((l) =>
      /^export class CentralizedKernelWorker/.test(l),
    );
    if (start < 0) return 0;
    let count = 0;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^\}/.test(lines[i]!) && i > start + 10) break;
      if (
        /^  (?:private |public |protected |static |readonly |async |\*)*[A-Za-z_$#][\w$]*\s*[(<]/
          .test(lines[i]!)
      ) {
        count += 1;
      }
    }
    return count;
  },
  // Layout modules the C side depends on, minus the ones the generated header
  // gives a static assert. The remainder can drift from musl silently.
  // Layout modules with no _Static_assert against musl. A #define hands C a
  // number; it does not check that C's own struct agrees. The original measure
  // counted modules the header DELIVERS, which could be satisfied by emitting
  // more #defines while nothing was guarded (H-2).
  // Modules whose C-side asserts are anchored to a generated KANDELO_ macro.
  // Asserting against a hand-written literal (as bits/stat.h does today) lets
  // C and the Rust authority drift apart while both look checked.
  // A layout module counts as guarded only when some C source asserts musl's
  // own struct against the GENERATED macro, the way channel_syscall.c already
  // does for siginfo_t:
  //
  //   _Static_assert(offsetof(siginfo_t, si_signo)
  //                      == KANDELO_PROCESS_SIGINFO_SIGNO_OFFSET, ...)
  //
  // Asserting against a hand-written literal does not count: bits/stat.h has 8
  // such asserts and they let C and the Rust authority drift apart while both
  // look checked. Macro prefixes do not follow module names, so the mapping is
  // explicit and must be extended when a module is added.
  unguardedLayoutModules: () => {
    const MACRO_PREFIX: Record<string, string> = {
      iovec: "IOVEC",
      msghdr: "MSGHDR",
      cmsghdr: "CMSGHDR",
      multicast_group_request: "GROUP_REQ",
      rt_sigqueueinfo: "SIGINFO",
      sigevent: "SIGEVENT",
      sigaltstack: "SIGALTSTACK",
      itimerval: "ITIMERVAL",
      mq_attr: "MQ_ATTR",
      statfs: "STATFS",
      sysinfo: "SYSINFO",
      stat: "STAT",
      dev: "DEV",
      statx: "STATX",
      sched_param: "SCHED_PARAM",
    };
    const declared = [
      ...readFileSync(
        join(repoRoot, "crates/shared/src/process_layout.rs"),
        "utf8",
      ).matchAll(/^pub mod ([a-z_]+)/gm),
    ].map((m) => m[1]!);
    for (const name of declared) {
      if (!MACRO_PREFIX[name]) {
        throw new Error(
          `process_layout module "${name}" has no macro prefix in the `
            + "unguardedLayoutModules measure; add one so the gate keeps counting it.",
        );
      }
    }
    // Every libc source, generated header excluded: its own #defines are
    // delivery, not guarding.
    const sources = execFileSync(
      "/bin/sh",
      [
        "-c",
        "find libc/musl-overlay libc/glue \\( -name '*.c' -o -name '*.h' \\) "
          + "2>/dev/null | grep -v kandelo_process_layouts.h "
          + "| xargs cat 2>/dev/null",
      ],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    // Asserts commonly go through one width-selecting alias, e.g.
    //   #define KANDELO_NATIVE_IOVEC_SIZE KANDELO_PROCESS_IOVEC_WASM32_SIZE
    // so resolve a single level of #define indirection before matching.
    const alias = new Map<string, string>();
    for (const m of sources.matchAll(
      /^[ \t]*#define[ \t]+(\w+)[ \t]+(?:\\[ \t]*\n[ \t]*)?(KANDELO_PROCESS_\w+)/gm,
    )) {
      alias.set(m[1]!, m[2]!);
    }
    const asserted = new Set<string>();
    for (const m of sources
      .replace(/\n/g, " ")
      .matchAll(/_Static_assert\s*\((.*?)\)\s*;/g)) {
      const resolved = [...m[1]!.matchAll(/KANDELO_\w+/g)].map(
        (r) => alias.get(r[0]) ?? r[0],
      );
      for (const [name, prefix] of Object.entries(MACRO_PREFIX)) {
        if (resolved.some((r) => r.startsWith(`KANDELO_PROCESS_${prefix}_`))) {
          asserted.add(name);
        }
      }
    }
    return declared.filter((name) => !asserted.has(name)).length;
  },
  // Fork imports the guest declares that the fork-module does NOT yet export
  // under the SAME name.
  //
  // # Why verbatim names, and why this is the definition of "done"
  //
  // `crates/shared/src/lib.rs` carries the canonical fork ABI as a table of
  // `ProgramArtifactImport { name, params, results }`. That table is the
  // contract -- not the host implementation, which is why it survived the host
  // TypeScript being set aside.
  //
  // When the fork-module exports an import under the guest's OWN name, wiring
  // the two together is a loop with no per-import knowledge in it:
  //
  //     for (const name of names) env[name] = forkModule.exports[name];
  //
  // `crates/host-native` already does exactly this for the five frame imports.
  // Every name the module exports under a DIFFERENT spelling (`fm_ref_gc_route`
  // for `__wpk_fork_ref_gc_route`) forces a mapping table back into the host,
  // and a hand-maintained mapping beside a generated contract is the defect
  // three separate censuses in this campaign have already found.
  //
  // So this counts what stands between here and a host layer that is pure
  // wiring. It reaches 0 when the module serves the whole guest fork ABI.
  forkGuestImportsUnserved: () => {
    const shared = readFileSync(
      join(repoRoot, "crates/shared/src/lib.rs"),
      "utf8",
    );
    const constants = new Map<string, string>();
    for (const m of shared.matchAll(
      /pub const (WPK_FORK_[A-Z0-9_]+): &str =\s*"([^"]+)"/g,
    )) {
      constants.set(m[1], m[2]);
    }
    const canonical = new Set<string>();
    for (const m of shared.matchAll(
      /ProgramArtifactImport\s*\{\s*module:\s*[A-Z_0-9]+,\s*name:\s*([A-Z_0-9]+),/g,
    )) {
      canonical.add(constants.get(m[1]) ?? m[1]);
    }
    const served = new Set<string>();
    const lib = readFileSync(
      join(repoRoot, "crates/fork-module/src/lib.rs"),
      "utf8",
    );
    for (const m of lib.matchAll(
      /pub (?:unsafe )?extern "C" fn ([A-Za-z_0-9]+)/g,
    )) {
      served.add(m[1]);
    }
    // Names the walrus pass injects are exports too: Rust cannot emit a
    // reference-returning function or a `call_indirect`, so those exports exist
    // only after injection and are just as real to the guest.
    const injected = readFileSync(
      join(repoRoot, "crates/fork-module-inject/src/main.rs"),
      "utf8",
    );
    for (const m of injected.matchAll(/"(__wpk_fork[a-z_0-9]+|fm_[a-z_0-9]+)"/g)) {
      served.add(m[1]);
    }
    return [...canonical].filter((name) => !served.has(name)).length;
  },
  // The guest's NON-FUNCTION fork imports the fork-module does not yet supply:
  // tables, globals and the unwind tag.
  //
  // `forkGuestImportsUnserved` above cannot see these. The canonical contract is
  // a table of `ProgramArtifactImport { name, params, results }`, and that shape
  // can only describe a FUNCTION -- so the five non-function imports a real
  // guest declares are absent from it by construction, not by drift. Measured
  // against a fork-instrumented guest binary: it imports 51 `env.__wpk_fork_*`
  // entries, the canonical table declares the 46 that are functions.
  //
  // They are counted separately rather than folded in, because serving one is
  // different work: a table or a tag is DEFINED and exported by the module
  // (`__wpk_fork_ref_gc_transit` and `__wpk_fork_unwind` already are), where a
  // function is implemented.
  forkGuestObjectImportsUnserved: () => {
    const shared = readFileSync(
      join(repoRoot, "crates/shared/src/lib.rs"),
      "utf8",
    );
    const names = new Set<string>();
    for (const constant of [
      "WPK_FORK_UNWIND_TAG_IMPORT_NAME",
      "WPK_FORK_REFERENCE_IMPORT_GC_TRANSIT",
      "WPK_FORK_RESUME_TABLE_IMPORT_NAME",
      "WPK_FORK_MODULE_ACTIVATION_IMPORT_NAME",
      "WPK_FORK_MODULE_STATE_TABLE_GENERATION_ADDR_IMPORT_NAME",
    ]) {
      const m = new RegExp(
        `pub const ${constant}: &str =\\s*"([^"]+)"`,
      ).exec(shared);
      if (m) names.add(m[1]);
    }
    // Fall back to the literal spellings for any constant this repo names
    // differently, so a rename cannot silently shrink the surface to zero.
    for (const literal of [
      "__wpk_fork_unwind",
      "__wpk_fork_ref_gc_transit",
      "__wpk_fork_resume_table",
      "__wpk_fork_module_activation",
      "__wpk_fork_module_state_table_generation_addr",
    ]) {
      names.add(literal);
    }
    // "Served" is decided by the BUILT ARTIFACT, not by grepping the
    // injector's source for string literals.
    //
    // The grep was a proxy and it could only ever be approximate: a name
    // mentioned in a COMMENT in `fork-module-inject/src/main.rs` counted as
    // served, so this surface could silently shrink without the module
    // exporting anything new. The two agreed when this changed (3 and 3) --
    // the point is that the artifact cannot disagree with itself, and the
    // grep can disagree with the artifact in either direction.
    //
    // This is the same correction `buildForkGuestImports` made: ask the thing
    // itself rather than a list, or a grep, of what someone remembered.
    const artifact = join(repoRoot, "host/wasm/fork_module32.wasm");
    if (!existsSync(artifact)) {
      throw new Error(
        `surface budget: ${artifact} is missing, so what the fork module ` +
          `serves cannot be measured. Build it with ` +
          `crates/fork-module/build-wasm.sh.`,
      );
    }
    const served = new Set(
      WebAssembly.Module.exports(
        new WebAssembly.Module(readFileSync(artifact)),
      ).map((entry) => entry.name),
    );
    return [...names].filter((name) => !served.has(name)).length;
  },
  kernelHostImportTypeScript: () => codeLineCount(["host/src/kernel.ts"]),
  hostKernelPlumbingTypeScript: () =>
    codeLineCount([
      "host/src/kernel-scratch.ts",
      "host/src/kernel-entry-gate.ts",
      "host/src/process-memory.ts",
      "host/src/worker-protocol.ts",
    ]),
  // Declaration names present in BOTH halves of a browser-/node- pair.
  // Members destructured from the shared createProcessLifecycle factory are
  // excluded: those are the consolidation working, not duplication.
  hostPeerDuplicateDeclarations: () => {
    const declPattern =
      /^(?:export\s+)?(?:async\s+)?(?:function|const|let|class|interface|type)\s+([A-Za-z_$][\w$]*)/gm;
    const declarations = (relPath: string): Set<string> => {
      const text = readFileSync(join(repoRoot, relPath), "utf8");
      const found = new Set(
        [...text.matchAll(declPattern)].map((m) => m[1]!),
      );
      const destructured = /const\s*\{([^}]*)\}\s*=\s*lifecycle/s.exec(text);
      if (destructured) {
        for (const raw of destructured[1]!.split(",")) {
          const name = raw.trim().split(":")[0]?.trim();
          if (name) found.delete(name);
        }
      }
      return found;
    };
    let total = 0;
    for (const base of [
      "kernel-host",
      "kernel-worker-entry",
      "kernel-protocol",
    ]) {
      const browser = declarations(`host/src/browser-${base}.ts`);
      for (const name of declarations(`host/src/node-${base}.ts`)) {
        if (browser.has(name)) total += 1;
      }
    }
    return total;
  },
  // Independent spellings of the artifact tier path across the writer
  // (xtask local-build) and both readers. Drift here already cost 39 of 53
  // host-native tests against a tree where the build had just succeeded.
  artifactTierPathSpellings: () =>
    Number.parseInt(
      execFileSync(
        "/bin/sh",
        [
          "-c",
          "grep -rn -E '\"local-binaries/source-only-v1\"|\"local-binaries\",[[:space:]]*\"source-only-v1\"' "
            + "--include='*.ts' --include='*.rs' --include='*.mjs' "
            + "host/src crates/host-native/src crates/shared/src tools/xtask/src scripts 2>/dev/null "
            + "| grep -vE '\\b(test|tests)\\b' "
            // Generated output is not an independent spelling: it is produced
            // FROM the authority, so counting it would penalise generating.
            + "| grep -v 'host/src/generated/' | wc -l",
        ],
        { cwd: repoRoot, encoding: "utf8" },
      ).trim(),
      10,
    ),
  imageBuilderFilesystemImporters: () =>
    Number.parseInt(
      execFileSync(
        "/bin/sh",
        [
          "-c",
          "grep -rl -E 'from \"[^\"]*(memory-fs|sharedfs-vendor)\"' "
            + "--include='*.ts' images/ | wc -l",
        ],
        { cwd: repoRoot, encoding: "utf8" },
      ).trim(),
      10,
    ),
  sessionHandMaintainedSyscallNames: () => {
    const text = readFileSync(
      join(repoRoot, "web-libs/kandelo-session/src/kernel-host.ts"),
      "utf8",
    );
    const start = text.indexOf("SYSCALL_NAMES_LOCAL: Record<number, string> = {");
    if (start < 0) return 0;
    const body = text.slice(start, text.indexOf("};", start));
    return [...body.matchAll(/\d+\s*:\s*"/g)].length;
  },
  sessionKernelFormatParsers: () => {
    const text = readFileSync(
      join(repoRoot, "web-libs/kandelo-session/src/kernel-host.ts"),
      "utf8",
    );
    // Parsers of kernel-emitted /proc text. The kernel holds this data
    // structured and serialises it; nothing binds these back to it.
    return [
      "parseMaps",
      "parseMounts",
      "parseProcEntry",
      "parseStatusBytes",
      "parseRangeSize",
    ].filter((name) => new RegExp(`function ${name}\\b`).test(text)).length;
  },
  // Non-test scripts computing a build-freshness digest: the tier that can
  // silently produce a wrong artifact. Loud tier-2 checks are counted too and
  // the target leaves room for them.
  buildFreshnessDigestsOutsideRust: () =>
    Number.parseInt(
      execFileSync(
        "/bin/sh",
        [
          "-c",
          "grep -rl -E 'git hash-object|shasum|sha256sum|createHash' "
            + "--include='*.sh' --include='*.mjs' --include='*.ts' scripts/ "
            + "| grep -vE '(^|/)test-|\\.test\\.' "
            + "| while read f; do grep -qiE "
            + "'input-hash|input_hash|cache|freshness|stamp|digest|manifest' "
            + "\"$f\" && echo \"$f\"; done | wc -l",
        ],
        { cwd: repoRoot, encoding: "utf8" },
      ).trim(),
      10,
    ),
  parseShebangReferences: () =>
    codeLineCount(["host/src/*.ts", "host/src/**/*.ts"]) > 0
      ? Number.parseInt(
          execFileSync("/bin/sh", [
            "-c",
            "grep -ro 'parseShebang' host/src 2>/dev/null | wc -l",
          ], { cwd: repoRoot, encoding: "utf8" }).trim(),
          10,
        )
      : 0,
  setuidLazyWithoutDigest: () => {
    const emitter = readFileSync(
      join(repoRoot, "scripts/generate-rootfs-package-manifest.mjs"),
      "utf8",
    );
    // The emitter's lazy branch writes `lazy_url=` and `lazy_size=`. Until it
    // also writes a digest, every setuid package that ships lazy is fetched
    // with length as its only check.
    if (/lazy_sha256=|lazy_digest=/.test(emitter)) return 0;
    const packages = readFileSync(
      join(repoRoot, "images/rootfs/PACKAGES.toml"),
      "utf8",
    );
    return packages
      .split(/\n(?=\[\[packages\]\])/)
      .filter((b) => /mode = "4755"/.test(b) && !/install = "eager"/.test(b))
      .length;
  },
  // ONE ratchet over the two buckets a reconnection moves entries BETWEEN.
  //
  // Splitting host-called from no-production-caller was right when they moved
  // independently. They stopped: reconnecting the thin layer gives an existing
  // entry a production caller, so it changes bucket and the two move equal and
  // opposite. That happened three times, total 46 each time, and each looked
  // like a raise in isolation. Their SUM only falls when the module absorbs work
  // or an entry is deleted, which is what this surface is for. The two are still
  // reported separately below for visibility; neither is ratcheted alone.
  // Imports in `host/src` that resolve into the attic instead of into
  // `host/src`.
  //
  // THE ONLY SURFACE THAT MEASURES THIS LANE'S ACTUAL GOAL. Every other number
  // here counts code that EXISTS; this one counts code the host still DEPENDS
  // on. That distinction was invisible and it mattered: a session spent moving
  // work into the module and cutting coordinator calls showed up as the host
  // surfaces GROWING, because the replacement is measured and the 14,035 attic
  // lines being replaced are measured by nothing. Progress looked like
  // regression, and the only reason anyone noticed was the maintainer asking.
  //
  // It counts distinct modules, not call sites: cutting the last reference to a
  // file is the event worth ratcheting, and cutting the first four of nine
  // references to it changes nothing about whether the file can be deleted.
  forkAtticImports: () => {
    const atticDir = join(repoRoot, "attic/fork-typescript-do-not-use");
    const sources = execFileSync(
      "/bin/sh",
      ["-c", "ls host/src/*.ts 2>/dev/null || true"],
      { cwd: repoRoot, encoding: "utf8" },
    )
      .split("\n")
      .filter((f) => f.length > 0);
    const unresolved = new Set<string>();
    for (const rel of sources) {
      const text = readFileSync(join(repoRoot, rel), "utf8");
      for (const [, specifier] of text.matchAll(/from "\.\/([a-z0-9-]+)"/g)) {
        if (existsSync(join(repoRoot, "host/src", `${specifier}.ts`))) continue;
        if (existsSync(join(atticDir, `${specifier}.ts`))) unresolved.add(specifier);
      }
    }
    return unresolved.size;
  },
  forkModuleHostEntries: () => {
    const entries = forkModuleEntries();
    return entries.hostCalled + entries.noProductionCaller;
  },
  forkModuleInjectorHelpers: () => forkModuleEntries().injectorOnly,
  forkModuleEntriesWithoutProductionCaller: () =>
    forkModuleEntries().noProductionCaller,
  sffsModuleEntryPoints: () =>
    countMatches(
      "crates/sffs-module/src/lib.rs",
      /^\s*pub (unsafe )?extern "C" fn sm_/,
    ),
};

/**
 * Source with COMMENTS removed and string literals KEPT.
 *
 * Both halves matter for caller classification. A doc comment naming an entry
 * is not a caller -- mentioning `fm_gc_identity_find` in a comment in
 * `host/src` once moved it from injector-only to host-called, which is the
 * whole classification being wrong from one sentence of prose. String literals
 * must SURVIVE, because `crates/host-native` binds its drive surface by name
 * inside one (`fm_func!("fm_parent_begin_capture": ...)`), so stripping
 * strings would hide every real caller it has.
 *
 * Quote tracking exists only so a `//` inside a string does not open a
 * comment; the contents are passed through untouched. Covers Rust `///` and
 * `//!` doc comments by the same `//` rule.
 */
function stripComments(source: string): string {
  let out = "";
  let inBlock = false;
  let inLine = false;
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (quote !== null) {
      out += ch;
      if (ch === "\\") {
        if (next !== undefined) out += next;
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    }
    out += ch;
  }
  return out;
}

/**
 * Classify every `fm_*` entry the fork-module declares by WHO CALLS IT.
 *
 * One ceiling over all of them could not mean anything, because they move for
 * opposite reasons: host-called entries should FALL as the drive API coarsens,
 * injector-only helpers RISE as each shim-backed guest import lands, and
 * entries with no production caller should fall to zero. A single number mixed
 * all three and blocked work it had no bearing on.
 *
 * No host constructs an `fm_*` name dynamically (checked 2026-09-12), so
 * matching by name is sound here.
 */
function forkModuleEntries(): {
  hostCalled: number;
  injectorOnly: number;
  noProductionCaller: number;
} {
  const lib = readFileSync(
    join(repoRoot, "crates/fork-module/src/lib.rs"),
    "utf8",
  );
  const names = [
    ...lib.matchAll(/^\s*pub (?:unsafe )?extern "C" fn (fm_[A-Za-z_0-9]+)/gm),
  ].map((m) => m[1]);

  const readAll = (dir: string, suffix: string): string => {
    const root = join(repoRoot, dir);
    return readdirSync(root)
      .filter((f) => f.endsWith(suffix))
      .map((f) => readFileSync(join(root, f), "utf8"))
      .join("\n");
  };
  // PRODUCTION hosts only. `host/test` is deliberately excluded: an entry only
  // a test reaches has no production caller, which is the H-1 signal the third
  // bucket exists to hold.
  const production = stripComments(
    readAll("crates/host-native/src", ".rs") + readAll("host/src", ".ts"),
  );
  const injector = stripComments(
    readFileSync(
      join(repoRoot, "crates/fork-module-inject/src/main.rs"),
      "utf8",
    ),
  );

  let hostCalled = 0;
  let injectorOnly = 0;
  let noProductionCaller = 0;
  for (const name of names) {
    const re = new RegExp(`\\b${name}\\b`);
    if (re.test(production)) hostCalled += 1;
    else if (re.test(injector)) injectorOnly += 1;
    else noProductionCaller += 1;
  }
  return { hostCalled, injectorOnly, noProductionCaller };
}

describe("campaign surface budget", () => {
  const surfaces = budget();

  it("measures every surface the budget declares", () => {
    // A budget entry nobody measures is the advisory document this test
    // exists to replace.
    expect(Object.keys(surfaces).sort()).toEqual(Object.keys(MEASURED).sort());
  });

  for (const [name, surface] of Object.entries(surfaces)) {
    it(`${name} has not grown past its ceiling`, () => {
      const actual = MEASURED[name]!();
      expect(
        actual,
        `${name} is ${actual}, above its ceiling of ${surface.ceiling}.\n`
          + `  measure: ${surface.measure}\n`
          + `  why it is capped: ${surface.why}\n`
          + `  Growing this surface needs an explicit decision, not a commit `
          + `that happens to add lines. If the growth is genuinely required, `
          + `raise the ceiling in docs/surface-budget.json in the same commit `
          + `and say why in the message.`,
      ).toBeLessThanOrEqual(surface.ceiling);
    });

    it(`${name} has its reduction banked in the ceiling`, () => {
      const actual = MEASURED[name]!();
      expect(
        actual,
        `${name} is ${actual}, which is more than ${surface.slack} below its `
          + `ceiling of ${surface.ceiling}.\n`
          + `  Lower the ceiling to ${actual} in docs/surface-budget.json in `
          + `this commit. An unbanked reduction silently funds the next `
          + `change's growth — which is how ${surface.ceiling === 24726 ? "this very surface" : "fork TypeScript"} `
          + `grew while a 4,643-line deletion elsewhere made it look like `
          + `progress.\n`
          + `  Target for this surface is ${surface.target}.`,
      ).toBeGreaterThan(surface.ceiling - surface.slack - 1);
    });
  }
});

/**
 * Lane closure is measured, not asserted.
 *
 * # Why this exists separately from the ceilings above
 *
 * A ceiling stops a surface growing. It says nothing about whether a lane is
 * *done* — and every previous attempt in this campaign expressed that in prose,
 * where it could be typed into a document by anyone and checked by no one. A
 * lane that claims closure it has not earned is the same failure as a guard
 * that cannot fail: it looks like evidence and is not.
 *
 * So this fails in both directions, for the same reason the ceilings do.
 * Claiming closure without meeting the conditions fails. Meeting every
 * condition while still marked open ALSO fails, because an unclaimed
 * completion is how a finished lane keeps absorbing effort.
 *
 * A lane whose completion genuinely is not a number declares `closure:
 * "manual"` and must say why. That is honest, and it is visible — which is the
 * difference between a judgement and an omission.
 */
describe("campaign lane closure", () => {
  const { surfaces, lanes } = readBudget();

  it("every lane states a closure condition or says why it cannot", () => {
    for (const [id, lane] of Object.entries(lanes)) {
      if (lane.closure === "checklist") {
        const items = Object.entries(lane.checklist ?? {});
        expect(items.length, `lane ${id} is checklist-closure with no items`)
          .toBeGreaterThan(0);
        const open = items.filter(([, done]) => !done).map(([k]) => k);
        if (lane.status === "closed") {
          expect(
            open,
            `lane ${id} is marked closed with unticked items: ${open.join(", ")}`,
          ).toEqual([]);
        } else {
          expect(
            open.length,
            `lane ${id} has every item ticked but is still marked `
              + `${lane.status}; close it in this commit`,
          ).toBeGreaterThan(0);
        }
        continue;
      }
      if (lane.closure === "manual") {
        expect(
          lane.why.length,
          `lane ${id} is manual-closure and must say why in its own words`,
        ).toBeGreaterThan(40);
        continue;
      }
      expect(lane.closure.length, `lane ${id} has an empty closure list`)
        .toBeGreaterThan(0);
      for (const condition of lane.closure) {
        expect(
          surfaces[condition.surface],
          `lane ${id} closes on surface "${condition.surface}", which the `
            + `budget does not measure`,
        ).toBeDefined();
      }
    }
  });

  for (const [id, lane] of Object.entries(lanes)) {
    if (lane.closure === "manual") continue;
    if (lane.closure === "checklist") continue;

    it(`lane ${id} (${lane.title}) — status matches its measurements`, () => {
      const unmet = lane.closure.filter(
        (c) => MEASURED[c.surface]!() > c.atMost,
      );
      const detail = lane.closure
        .map((c) => `${c.surface}=${MEASURED[c.surface]!()} (needs <= ${c.atMost})`)
        .join(", ");

      if (lane.status === "closed") {
        expect(
          unmet,
          `lane ${id} is marked closed but has not met its own conditions: `
            + `${detail}.\n  ${lane.why}\n  A lane is closed when the `
            + `measurement says so. Marking it closed first is how work that `
            + `moved an algorithm and left its driver behind got counted as `
            + `done, ten times over.`,
        ).toEqual([]);
      } else {
        expect(
          unmet.length,
          `lane ${id} is marked ${lane.status} but meets every closure `
            + `condition: ${detail}.\n  Close it in `
            + `docs/surface-budget.json and in the master plan, in this `
            + `commit. An unclaimed completion keeps absorbing effort.`,
        ).toBeGreaterThan(0);
      }
    });
  }
});

/**
 * The plan's own rule, applied to the plan.
 *
 * The master plan states that a lane is not dispatchable until its section
 * gives an end state, a floor, increments, acceptance evidence and known
 * hazards. Nine of eleven lanes violated that rule while several described
 * themselves as "characterized" — which is a status asserted in prose that
 * nothing checked, the exact failure the file was written to end, reproduced
 * inside it.
 *
 * A lane legitimately missing a section declares `sectionsExempt` in the
 * budget with a reason. Declaring an exemption is a decision; being silently
 * short is not.
 */
describe("master plan characterization", () => {
  const { lanes } = readBudget();
  const REQUIRED = [
    ["endState", /^## End state/m],
    ["floor", /^## (The floor|.*floor)/m],
    ["increments", /^## Increments/m],
    ["acceptance", /^## Acceptance/m],
    ["hazards", /^## Known hazard/m],
  ] as const;

  const plan = readFileSync(
    join(repoRoot, "docs/plans/2026-09-11-MASTER-PLAN.md"),
    "utf8",
  );
  const sections = new Map<string, string>();
  for (const block of plan.split(/^# LANE /m).slice(1)) {
    sections.set(block.trim().charAt(0), block);
  }

  it("estimates every lane in the budget", () => {
    // An estimates table that silently falls behind the roster is how nine
    // lanes came to be uncosted. Every lane gets a row or the gate fails.
    const estimated = new Set(
      [...plan.matchAll(/^\| \*\*([A-Z])\*\*[^|]*\|\s*\*\*[^|]*d\*\*/gm)].map(
        (m) => m[1]!,
      ),
    );
    const missing = Object.keys(lanes).filter((id) => !estimated.has(id));
    expect(
      missing,
      `lanes with no row in the estimates table: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("has a plan section for every lane in the budget", () => {
    expect([...sections.keys()].sort()).toEqual(Object.keys(lanes).sort());
  });

  for (const [id, lane] of Object.entries(lanes)) {
    const exempt = new Set((lane as { sectionsExempt?: string[] }).sectionsExempt ?? []);

    it(`lane ${id} carries every section it has not exempted`, () => {
      const body = sections.get(id) ?? "";
      const missing = REQUIRED
        .filter(([name, re]) => !exempt.has(name) && !re.test(body))
        .map(([name]) => name);
      expect(
        missing,
        `lane ${id} (${lane.title}) is missing: ${missing.join(", ")}.\n`
          + `  The plan's own rule is that a lane is not dispatchable without `
          + `these. If one genuinely does not apply, add it to `
          + `sectionsExempt in docs/surface-budget.json with a reason — a `
          + `declared exemption is a decision, and being silently short is how `
          + `nine lanes came to call themselves characterized.`,
      ).toEqual([]);
    });

    if ((lane as { sectionsExempt?: string[] }).sectionsExempt?.length) {
      it(`lane ${id} says why it is exempt`, () => {
        expect(
          ((lane as { whyExempt?: string }).whyExempt ?? "").length,
          `lane ${id} exempts sections without saying why`,
        ).toBeGreaterThan(40);
      });
    }
  }
});
