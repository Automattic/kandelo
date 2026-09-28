/**
 * uuencode must produce historical uuencode (and base64 with -m), and
 * uudecode must restore the file. The replaced posix-utils-lite uuencode
 * always wrote base64, even without -m.
 */
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const dash = tryResolveBinary("programs/dash.wasm");
const coreutils = tryResolveBinary("programs/coreutils.wasm");
const uuencode = tryResolveBinary("programs/sharutils/uuencode.wasm");
const uudecode = tryResolveBinary("programs/sharutils/uudecode.wasm");
const programs: Record<string, string | null> = {
  cat: coreutils,
  cp: coreutils,
  od: coreutils,
  wc: coreutils,
  cmp: tryResolveBinary("programs/diffutils/cmp.wasm"),
  uuencode,
  uudecode,
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

describe.skipIf(!artifactsAvailable)("sharutils uuencode/uudecode", () => {
  it("writes historical uuencode by default", async () => {
    const result = await sh("cd /tmp; printf 'Cat' > in; uuencode in remote.txt");
    // "Cat" is 3 bytes: length char "#", then 4 characters.
    expect(result.stdout).toBe("begin 644 remote.txt\n#0V%T\n`\nend\n");
  }, 60_000);

  it("writes base64 with -m", async () => {
    const result = await sh("cd /tmp; printf 'Cat' > in; uuencode -m in remote.txt");
    expect(result.stdout).toBe("begin-base64 644 remote.txt\nQ2F0\n====\n");
  }, 60_000);

  it("round-trips binary data in both encodings", async () => {
    const result = await sh([
      "cd /tmp",
      "printf '\\000\\001\\377binary\\n' > orig",
      "uuencode orig out1 > a.uu && uudecode a.uu && cmp orig out1 && echo UU_OK",
      "uuencode -m orig out2 > b.uu && uudecode b.uu && cmp orig out2 && echo B64_OK",
    ].join("; "));
    expect(result.stdout).toBe("UU_OK\nB64_OK\n");
  }, 60_000);
});
