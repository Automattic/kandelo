/**
 * pax must write standard archives and read them back. The replaced
 * posix-utils-lite pax wrote an invented format.
 */
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const dash = tryResolveBinary("programs/dash.wasm");
const coreutils = tryResolveBinary("programs/coreutils.wasm");
const pax = tryResolveBinary("programs/pax.wasm");
const programs: Record<string, string | null> = {
  cat: coreutils,
  ls: coreutils,
  mkdir: coreutils,
  od: coreutils,
  cmp: tryResolveBinary("programs/diffutils/cmp.wasm"),
  grep: tryResolveBinary("programs/grep.wasm"),
  pax,
  cut: coreutils,
};
const artifactsAvailable = !!dash && Object.values(programs).every(Boolean);

/** Quote `text` as one POSIX shell word. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * Run `script` in dash with the named programs mapped to their resolved
 * binaries. Inputs are written with printf inside the script rather than
 * piped from the host.
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

describe.skipIf(!artifactsAvailable)("MirBSD pax", () => {
  it("round-trips a directory through a ustar archive", async () => {
    const result = await sh([
      "cd /tmp",
      "mkdir -p src/sub",
      "printf 'alpha\\n' > src/a.txt",
      "printf 'beta\\n' > src/sub/b.txt",
      "pax -w -x ustar -f out.tar src; echo WRITE_RC=$?",
      // ustar magic lives at offset 257 of the first header block.
      "od -An -c -j 257 -N 5 out.tar",
      "pax -f out.tar | sort",
      "mkdir dest && cd dest && pax -r -f ../out.tar; echo READ_RC=$?",
      "cmp src/a.txt ../src/a.txt && cmp src/sub/b.txt ../src/sub/b.txt && echo IDENTICAL",
    ].join("; "));
    expect(result.stdout).toBe(
      "WRITE_RC=0\n   u   s   t   a   r\nsrc\nsrc/a.txt\nsrc/sub\nsrc/sub/b.txt\n" +
        "READ_RC=0\nIDENTICAL\n",
    );
  }, 60_000);
});
