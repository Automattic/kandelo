/**
 * flex, installed as lex, must generate a scanner from the specification.
 * The replaced posix-utils-lite lex ignored the specification and always
 * wrote the same fixed echo loop.
 */
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const dash = tryResolveBinary("programs/dash.wasm");
const coreutils = tryResolveBinary("programs/coreutils.wasm");
const flex = tryResolveBinary("programs/flex.wasm");
const m4 = tryResolveBinary("programs/m4.wasm");
const programs: Record<string, string | null> = {
  cat: coreutils,
  ls: coreutils,
  mkdir: coreutils,
  od: coreutils,
  cmp: tryResolveBinary("programs/diffutils/cmp.wasm"),
  grep: tryResolveBinary("programs/grep.wasm"),
  flex,
  lex: flex,
  m4,
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

const SPEC = [
  "%option noyywrap",
  "%%",
  "[0-9]+  { printf(\"NUMBER_TOKEN\\n\"); }",
  "[a-z]+  { printf(\"WORD_TOKEN\\n\"); }",
  "%%",
  "",
].join("\n");

describe.skipIf(!artifactsAvailable)("flex as lex", () => {
  it("generates a scanner containing the specification's actions", async () => {
    const result = await sh([
      "cd /tmp",
      `printf '%s' ${shellQuote(SPEC)} > scan.l`,
      "lex scan.l; echo LEX_RC=$?",
      "grep -c NUMBER_TOKEN lex.yy.c",
      "grep -c WORD_TOKEN lex.yy.c",
      "grep -c 'yylex' lex.yy.c > /dev/null && echo HAS_YYLEX",
      "lex -t scan.l | grep -c NUMBER_TOKEN",
    ].join("; "));
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("LEX_RC=0\n1\n1\nHAS_YYLEX\n1\n");
  }, 60_000);

  it("rejects a malformed specification", async () => {
    const result = await sh(
      "cd /tmp; printf '%%%%\\n[0-9 { broken\\n' > bad.l; lex bad.l; echo RC=$?",
    );
    expect(result.stdout).not.toContain("RC=0");
    expect(result.stderr).not.toBe("");
  }, 60_000);
});
