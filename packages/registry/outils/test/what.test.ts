/**
 * what must print each file name once, followed by every @(#) string in
 * it; -s stops after the first. The replaced posix-utils-lite what
 * repeated the file name for each match.
 */
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const dash = tryResolveBinary("programs/dash.wasm");
const coreutils = tryResolveBinary("programs/coreutils.wasm");
const what = tryResolveBinary("programs/what.wasm");
const programs: Record<string, string | null> = {
  cat: coreutils,
  cp: coreutils,
  od: coreutils,
  wc: coreutils,
  cmp: tryResolveBinary("programs/diffutils/cmp.wasm"),
  what,
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

describe.skipIf(!artifactsAvailable)("outils what", () => {
  it("lists every identification string under one file name", async () => {
    const result = await sh(
      "cd /tmp; printf 'x@(#)first ident\\0y@(#)second ident\\n' > obj; what obj; echo RC=$?",
    );
    expect(result.stdout).toBe("obj:\n\tfirst ident\n\tsecond ident\nRC=0\n");
  }, 60_000);

  it("stops after the first string with -s and fails when none match", async () => {
    const result = await sh([
      "cd /tmp",
      "printf 'x@(#)first\\0y@(#)second\\n' > obj",
      "what -s obj",
      "printf 'nothing here' > plain",
      "what plain > /dev/null; echo NONE_RC=$?",
    ].join("; "));
    expect(result.stdout).toBe("obj:\n\tfirst\nNONE_RC=1\n");
  }, 60_000);
});
