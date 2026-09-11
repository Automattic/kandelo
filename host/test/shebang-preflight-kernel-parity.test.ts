/**
 * The spawn preflight must not re-decide `#!` — or executability — itself.
 *
 * WHY this is a correctness test and not tidiness. `#handleSpawn`
 * (host/src/kernel-worker.ts) runs a side-effect-free preflight BEFORE
 * `kernel_spawn_process`, so a program that cannot launch fails without
 * creating a child and without applying `file_actions` — POSIX requires a
 * spawn's file actions to run exactly once, and the preflight is what keeps a
 * doomed candidate from consuming that one run.
 *
 * The authority for `#!` and for executability is the kernel:
 * `exec_target::probe` (crates/runtime-core/src/exec_target.rs) resolves
 * exactly ONE interpreter retarget, fails ENOEXEC on a nested chain, refuses a
 * directory with EACCES, and enforces `X_OK` — the same rules
 * `launchPreparedExecTarget` goes through for every real launch.
 *
 * The host used to keep a second copy of the `#!` half in TypeScript and no
 * copy at all of the executability half. The two `#!` parsers disagreed: the
 * host followed four levels where the kernel follows one, so a nested script
 * passed the preflight, the kernel built the child and applied `file_actions`,
 * and only then did the authoritative resolve report ENOEXEC — the exact
 * outcome the preflight exists to prevent. This pins the host out of that
 * business, across a TypeScript/Rust boundary where neither compiler nor any
 * single-language suite can see both halves.
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

describe("the spawn preflight defers `#!` and executability to the kernel", () => {
  it("keeps no host-side `#!` parser", () => {
    // A second parser for one format is the defect, not the line count: two
    // can disagree, and they did.
    expect(
      /export function parseShebang\(/.test(lifecycleSrc),
      "process-lifecycle.ts must not define a host-side `#!` parser",
    ).toBe(false);
    // Match the DECLARATION, not any mention: the retirement comment names
    // both symbols on purpose, and a test that forbade the word would forbid
    // explaining why they left.
    expect(
      /(?:export )?const MAX_SHEBANG_DEPTH\s*=/.test(lifecycleSrc),
      "a host-side `#!` depth limit is a host-side `#!` policy; the kernel " +
        "owns the one-retarget rule",
    ).toBe(false);
  });

  it("asks the kernel what a launch would run", () => {
    const body = resolveExecutableForLaunchSource();
    expect(
      /execTargetProbe\(ownerPid, callerTid, AT_FDCWD, path, 0\)/.test(body),
      "the preflight must resolve its target through the kernel probe",
    ).toBe(true);
    // The probe is a kernel entry the gate can defer; retrying it is only
    // sound because it retains nothing.
    expect(
      /retryKernelEntryResult\(/.test(body),
      "the probe must be retried through the kernel-entry gate helper",
    ).toBe(true);
  });

  it("treats every kernel errno except ENOENT as final", () => {
    // ENOENT falls through to Node's host program maps, which the kernel VFS
    // does not know about. Letting anything else fall through would swallow
    // the kernel's authoritative refusal (EACCES for a directory or a
    // non-executable, ENOEXEC for a nested chain) and hand the guest a
    // "missing file" for a file that is plainly there.
    const body = resolveExecutableForLaunchSource();
    expect(
      /probed\.errno !== EXEC_OVERLAY_ENOENT_ERRNO/.test(body),
      "only ENOENT may fall through to the host-map byte fallback",
    ).toBe(true);
    expect(
      /return \{ errno: probed\.errno \};/.test(body),
      "a non-ENOENT probe errno must be returned to the guest unchanged",
    ).toBe(true);
  });

  it("still resolves exactly one `#!` level in the kernel, ENOEXEC beyond", () => {
    // Read the limit from the authority itself rather than assuming it.
    const resolve = /pub fn resolve_shebang\(/.exec(execTargetRs);
    expect(resolve, "exec_target.rs must declare resolve_shebang").not.toBeNull();
    const body = execTargetRs.slice(resolve!.index, resolve!.index + 4000);
    expect(
      /Ok\(Some\(_\)\)\s*=>\s*\{/.test(body),
      "resolve_shebang must branch on the interpreter itself being a script",
    ).toBe(true);
    expect(
      /return Err\(Errno::ENOEXEC\);/.test(body),
      "resolve_shebang must fail a nested `#!` chain with ENOEXEC",
    ).toBe(true);
  });

  it("keeps the probe retain-nothing on both of its paths", () => {
    // The preflight may be called twice per spawn, again under EAGAIN retry,
    // again after a deferred kernel entry, and on a path that can be abandoned
    // with no rollback. Every one of those repeats is only safe because the
    // probe leaves the prepared-target ledger exactly as it found it.
    const probe = /pub fn probe\(/.exec(execTargetRs);
    expect(probe, "exec_target.rs must declare probe").not.toBeNull();
    const body = execTargetRs.slice(probe!.index, probe!.index + 2000);
    const releases = body.match(/let _ = cancel\(/g) ?? [];
    expect(
      releases.length,
      "probe must release on BOTH the success and the failure path",
    ).toBe(2);
  });
});
