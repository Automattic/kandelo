/**
 * byacc, installed as yacc, must generate a parser from the grammar. The
 * replaced posix-utils-lite yacc ignored the grammar.
 */
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const dash = tryResolveBinary("programs/dash.wasm");
const coreutils = tryResolveBinary("programs/coreutils.wasm");
const yacc = tryResolveBinary("programs/yacc.wasm");
const programs: Record<string, string | null> = {
  cat: coreutils,
  ls: coreutils,
  mkdir: coreutils,
  od: coreutils,
  cmp: tryResolveBinary("programs/diffutils/cmp.wasm"),
  grep: tryResolveBinary("programs/grep.wasm"),
  yacc,
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

const GRAMMAR = [
  "%token NUMBER PLUS",
  "%%",
  "expr : expr PLUS NUMBER { printf(\"ADD_ACTION\\n\"); }",
  "     | NUMBER",
  "     ;",
  "%%",
  "",
].join("\n");

describe.skipIf(!artifactsAvailable)("byacc as yacc", () => {
  it("writes y.tab.c with the grammar's actions and y.tab.h with -d", async () => {
    const result = await sh([
      "cd /tmp",
      `printf '%s' ${shellQuote(GRAMMAR)} > g.y`,
      "yacc -d g.y; echo YACC_RC=$?",
      "grep -c ADD_ACTION y.tab.c",
      "grep -E '#define (NUMBER|PLUS) ' y.tab.h | sort",
    ].join("; "));
    expect(result.stdout).toBe(
      "YACC_RC=0\n1\n#define NUMBER 257\n#define PLUS 258\n",
    );
  }, 60_000);

  it("reports a grammar error and fails", async () => {
    // The action's brace is never closed.
    const bad = "%token A\n%%\nexpr : A { unterminated\n";
    const result = await sh(`cd /tmp; printf '%s' ${shellQuote(bad)} > bad.y; yacc bad.y; echo RC=$?`);
    expect(result.stdout).not.toContain("RC=0");
    expect(result.stderr).not.toBe("");
  }, 60_000);
});
