/**
 * Shebang nesting parity — the spawn preflight must refuse exactly what the
 * kernel refuses, with the kernel's errno.
 *
 * WHY this is a correctness test and not tidiness. `#handleSpawn`
 * (host/src/kernel-worker.ts) runs a deliberately side-effect-free preflight
 * BEFORE `kernel_spawn_process`, so that a program which cannot launch fails
 * without creating a child and without applying `file_actions` — POSIX
 * requires a spawn's file actions to run exactly once, and the preflight is
 * what keeps a doomed candidate from consuming that one run.
 *
 * The authority for `#!` is the kernel: `resolve_shebang`
 * (crates/runtime-core/src/exec_target.rs) resolves exactly ONE level and
 * fails ENOEXEC when the decoded interpreter is itself a script, and
 * `launchPreparedExecTarget` (host/src/exec-target.ts) is the path every real
 * launch takes. The host preflight parses `#!` a second time only to find the
 * bytes it should pre-compile; its rewritten argv is discarded (the launch
 * uses `originalArgv`).
 *
 * If the preflight admits a DEEPER chain than the kernel, a nested-shebang
 * spawn passes the preflight, the kernel builds the child and applies
 * `file_actions`, and only then does the authoritative resolve report
 * ENOEXEC — the exact outcome the preflight exists to prevent. That is the
 * regression this test pins, across the TypeScript/Rust boundary where no
 * compiler and no single-language suite can see both halves.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

const lifecycleSrc = readFileSync(
  join(repoRoot, "host", "src", "process-lifecycle.ts"),
  "utf8",
);
const execTargetRs = readFileSync(
  join(repoRoot, "crates", "runtime-core", "src", "exec_target.rs"),
  "utf8",
);

/** The body of `resolveExecutableForLaunch`, bounded by the next declaration. */
function resolveExecutableForLaunchSource(): string {
  const opening = /\n  async function resolveExecutableForLaunch\(/.exec(
    lifecycleSrc,
  );
  expect(
    opening,
    "process-lifecycle.ts must declare resolveExecutableForLaunch",
  ).not.toBeNull();
  const start = opening!.index;
  const next = /\n  (?:async )?function /.exec(lifecycleSrc.slice(start + 1));
  expect(next, "resolveExecutableForLaunch must be followed by a declaration")
    .not.toBeNull();
  return lifecycleSrc.slice(start, start + 1 + next!.index);
}

describe("shebang nesting parity between the spawn preflight and the kernel", () => {
  it("resolves exactly one `#!` level in the kernel, failing ENOEXEC beyond", () => {
    // The kernel's limit, read from the authority itself rather than assumed.
    const resolve = /pub fn resolve_shebang\(/.exec(execTargetRs);
    expect(resolve, "exec_target.rs must declare resolve_shebang").not.toBeNull();
    const body = execTargetRs.slice(resolve!.index, resolve!.index + 4000);

    // A freshly prepared interpreter that is itself a script is rejected...
    expect(
      /Ok\(Some\(_\)\)\s*=>\s*\{/.test(body),
      "resolve_shebang must branch on the interpreter itself being a script",
    ).toBe(true);
    // ...with ENOEXEC, and no retained token.
    expect(
      /return Err\(Errno::ENOEXEC\);/.test(body),
      "resolve_shebang must fail a nested `#!` chain with ENOEXEC",
    ).toBe(true);
  });

  it("caps the host preflight at the kernel's one retarget", () => {
    const m = /export const MAX_SHEBANG_DEPTH = (\d+);/.exec(lifecycleSrc);
    expect(m, "process-lifecycle.ts must export MAX_SHEBANG_DEPTH").not.toBeNull();
    expect(
      Number(m![1]),
      "the preflight must permit exactly the kernel's one `#!` retarget; a " +
        "larger value admits chains the authoritative resolve rejects only " +
        "AFTER kernel_spawn_process has applied file_actions",
    ).toBe(1);
  });

  it("refuses a too-deep chain with ENOEXEC rather than reporting ENOENT", () => {
    const body = resolveExecutableForLaunchSource();
    expect(
      /if \(depth >= MAX_SHEBANG_DEPTH\) return \{ errno: ENOEXEC \};/.test(body),
      "a nested `#!` chain must surface the kernel's ENOEXEC; returning null " +
        "makes handleSpawn complete SYS_SPAWN with ENOENT instead",
    ).toBe(true);
    expect(
      /depth > MAX_SHEBANG_DEPTH\) return null/.test(body),
      "the depth guard must not return null — that is the ENOENT divergence",
    ).toBe(false);
  });

  it("checks the depth only after deciding the target is a script", () => {
    // Ordering matters: a NON-script at the limit is a legitimate launch, so
    // the cap must gate the recursion, never the successful resolution.
    const body = resolveExecutableForLaunchSource();
    const shebangAt = body.indexOf("const shebang = parseShebang(bytes);");
    const depthAt = body.indexOf("if (depth >= MAX_SHEBANG_DEPTH)");
    const recurseAt = body.indexOf("resolveExecutableForLaunch(shebang.interpreter");
    expect(shebangAt, "the preflight must parse the shebang").toBeGreaterThan(-1);
    expect(depthAt, "the preflight must cap the chain depth").toBeGreaterThan(-1);
    expect(recurseAt, "the preflight must retarget the interpreter").toBeGreaterThan(-1);
    expect(depthAt).toBeGreaterThan(shebangAt);
    expect(recurseAt).toBeGreaterThan(depthAt);
  });
});
