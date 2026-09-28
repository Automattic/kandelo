/**
 * GNU cflow must print the call graph of C sources. The replaced
 * posix-utils-lite cflow did not analyze its input.
 */
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const dash = tryResolveBinary("programs/dash.wasm");
const coreutils = tryResolveBinary("programs/coreutils.wasm");
const cflow = tryResolveBinary("programs/cflow.wasm");
const programs: Record<string, string | null> = {
  cat: coreutils,
  ls: coreutils,
  mkdir: coreutils,
  od: coreutils,
  cmp: tryResolveBinary("programs/diffutils/cmp.wasm"),
  grep: tryResolveBinary("programs/grep.wasm"),
  cflow,
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

const SOURCE = [
  "static int leaf(void) { return 1; }",
  "static int middle(void) { return leaf(); }",
  "int main(void) { return middle(); }",
  "",
].join("\n");

describe.skipIf(!artifactsAvailable)("GNU cflow", () => {
  it("prints main's call tree", async () => {
    const result = await sh(`cd /tmp; printf '%s' ${shellQuote(SOURCE)} > f.c; cflow f.c`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "main() <int main (void) at f.c:3>:\n" +
        "    middle() <int middle (void) at f.c:2>:\n" +
        "        leaf() <int leaf (void) at f.c:1>\n",
    );
  }, 60_000);
});
