/**
 * compress must write LZW .Z data and uncompress must restore it. The
 * replaced posix-utils-lite compress copied its input unchanged into X.Z.
 */
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const dash = tryResolveBinary("programs/dash.wasm");
const coreutils = tryResolveBinary("programs/coreutils.wasm");
const compress = tryResolveBinary("programs/compress.wasm");
const programs: Record<string, string | null> = {
  cat: coreutils,
  cp: coreutils,
  od: coreutils,
  wc: coreutils,
  cmp: tryResolveBinary("programs/diffutils/cmp.wasm"),
  compress,
  uncompress: compress,
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

describe.skipIf(!artifactsAvailable)("ncompress", () => {
  it("round-trips a file through compress and uncompress", async () => {
    const result = await sh([
      "cd /tmp",
      "i=0; while [ $i -lt 200 ]; do echo 'the same line again and again'; i=$((i+1)); done > data",
      "cp data data.orig",
      "compress -f data; echo COMPRESS_RC=$?",
      "test ! -e data && echo ORIGINAL_REPLACED",
      "od -An -tx1 -N2 data.Z",
      "test $(wc -c < data.Z) -lt $(wc -c < data.orig) && echo SMALLER",
      "uncompress data.Z; echo UNCOMPRESS_RC=$?",
      "cmp data data.orig && echo IDENTICAL",
    ].join("; "));
    expect(result.stdout).toBe(
      "COMPRESS_RC=0\nORIGINAL_REPLACED\n 1f 9d\nSMALLER\nUNCOMPRESS_RC=0\nIDENTICAL\n",
    );
  }, 60_000);

  it("refuses to uncompress data that is not .Z", async () => {
    const result = await sh("cd /tmp; printf 'plain text' > bad.Z; uncompress -c bad.Z > /dev/null; echo RC=$?");
    expect(result.stdout).not.toContain("RC=0");
  }, 60_000);
});
