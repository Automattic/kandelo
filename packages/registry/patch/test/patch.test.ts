/**
 * GNU patch must really apply a diff. The replaced posix-utils-lite patch
 * printed "patching file X" and changed nothing.
 */
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const dash = tryResolveBinary("programs/dash.wasm");
const coreutils = tryResolveBinary("programs/coreutils.wasm");
const patch = tryResolveBinary("programs/patch.wasm");
const ed = tryResolveBinary("programs/ed.wasm");
const programs: Record<string, string | null> = {
  cat: coreutils,
  cp: coreutils,
  od: coreutils,
  wc: coreutils,
  cmp: tryResolveBinary("programs/diffutils/cmp.wasm"),
  patch,
  ed,
  sh: dash,
};
const artifactsAvailable = !!dash && Object.values(programs).every(Boolean);

/** Quote `text` as one POSIX shell word. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * Run `script` in dash with the named programs mapped to their resolved
 * binaries. Inputs are written with printf inside the script rather than
 * piped from the host (see node-host finite-stdin note in the PR).
 */
async function sh(script: string) {
  const execPrograms = new Map<string, string>();
  for (const [name, path] of Object.entries(programs)) {
    execPrograms.set(`/bin/${name}`, path!);
    execPrograms.set(`/usr/bin/${name}`, path!);
  }
  return runCentralizedProgram({
    programPath: dash!,
    argv: ["dash", "-c", script],
    env: ["PATH=/bin:/usr/bin", "HOME=/tmp"],
    execPrograms,
    timeout: 60_000,
  });
}

const ORIGINAL = "alpha\nbeta\ngamma\n";
const DIFF = [
  "--- a/f.txt",
  "+++ b/f.txt",
  "@@ -1,3 +1,3 @@",
  " alpha",
  "-beta",
  "+BETA",
  " gamma",
  "",
].join("\n");

describe.skipIf(!artifactsAvailable)("GNU patch", () => {
  it("applies a unified diff and reverses it with -R", async () => {
    const result = await sh([
      "cd /tmp",
      `printf '%s' ${shellQuote(ORIGINAL)} > f.txt`,
      `printf '%s' ${shellQuote(DIFF)} > fix.diff`,
      "patch -p1 < fix.diff; echo APPLY_RC=$?",
      "cat f.txt",
      "patch -R -p1 < fix.diff; echo REVERSE_RC=$?",
      "cat f.txt",
    ].join("; "));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "patching file f.txt\nAPPLY_RC=0\nalpha\nBETA\ngamma\n" +
        "patching file f.txt\nREVERSE_RC=0\nalpha\nbeta\ngamma\n",
    );
  }, 60_000);

  it("applies an ed-style diff by running ed", async () => {
    // `diff -e` output. GNU patch hands ed scripts to /usr/bin/ed through
    // /bin/sh.
    const result = await sh([
      "cd /tmp",
      `printf '%s' ${shellQuote(ORIGINAL)} > f.txt`,
      "printf '2c\\nBETA\\n.\\n' > fix.ed",
      "patch -e f.txt fix.ed; echo RC=$?",
      "cat f.txt",
    ].join("; "));
    expect(result.stdout).toBe("RC=0\nalpha\nBETA\ngamma\n");
  }, 60_000);

  it("rejects a hunk that does not apply and writes a .rej file", async () => {
    const result = await sh([
      "cd /tmp",
      "printf 'one\\ntwo\\nthree\\n' > f.txt",
      `printf '%s' ${shellQuote(DIFF)} > fix.diff`,
      "patch -p1 < fix.diff > /dev/null; echo RC=$?",
      "cat f.txt",
      "test -s f.txt.rej && echo REJECT_WRITTEN",
    ].join("; "));
    expect(result.stdout).toBe("RC=1\none\ntwo\nthree\nREJECT_WRITTEN\n");
  }, 60_000);
});
