/**
 * Universal Ctags, installed as ctags, must index definitions in C source.
 * The replaced posix-utils-lite ctags did not parse its input.
 */
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const dash = tryResolveBinary("programs/dash.wasm");
const coreutils = tryResolveBinary("programs/coreutils.wasm");
const ctags = tryResolveBinary("programs/ctags.wasm");
const programs: Record<string, string | null> = {
  cat: coreutils,
  ls: coreutils,
  mkdir: coreutils,
  od: coreutils,
  cmp: tryResolveBinary("programs/diffutils/cmp.wasm"),
  grep: tryResolveBinary("programs/grep.wasm"),
  ctags,
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
  "#define LIMIT 10",
  "struct point { int x; };",
  "int area(int w, int h) { return w * h; }",
  "",
].join("\n");

describe.skipIf(!artifactsAvailable)("Universal Ctags", () => {
  it("writes a sorted tags file naming each definition", async () => {
    const result = await sh([
      "cd /tmp",
      `printf '%s' ${shellQuote(SOURCE)} > shapes.c`,
      "ctags shapes.c; echo RC=$?",
      "grep -v '^!_TAG' tags | cut -f1,2",
    ].join("; "));
    expect(result.stdout).toBe("RC=0\nLIMIT\tshapes.c\narea\tshapes.c\npoint\tshapes.c\nx\tshapes.c\n");
  }, 60_000);

  it("prints a POSIX -x index", async () => {
    const result = await sh(`cd /tmp; printf '%s' ${shellQuote(SOURCE)} > shapes.c; ctags -x shapes.c`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^area\s+function\s+3\s+shapes\.c\s+int area/m);
  }, 60_000);
});
