/**
 * GNU ed must run the POSIX ed command language. The replaced
 * posix-utils-lite ed understood a few one-letter commands and silently
 * ignored everything else, still exiting 0.
 */
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const dash = tryResolveBinary("programs/dash.wasm");
const coreutils = tryResolveBinary("programs/coreutils.wasm");
const ed = tryResolveBinary("programs/ed.wasm");
const programs: Record<string, string | null> = {
  cat: coreutils,
  cp: coreutils,
  od: coreutils,
  wc: coreutils,
  cmp: tryResolveBinary("programs/diffutils/cmp.wasm"),
  ed,
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

async function edScript(original: string, commands: string[]) {
  return sh([
    `printf '%s' ${shellQuote(original)} > /tmp/f.txt`,
    `printf '%s\\n' ${commands.map(shellQuote).join(" ")} > /tmp/cmds`,
    "ed -s /tmp/f.txt < /tmp/cmds; echo ED_RC=$?",
    "cat /tmp/f.txt",
  ].join("; "));
}

describe.skipIf(!artifactsAvailable)("GNU ed", () => {
  it("applies global, substitute, move, and append commands", async () => {
    const result = await edScript("one\ntwo\nthree\n", [
      "g/o/s/o/0/g",
      "1m$",
      "$a",
      "four",
      ".",
      "w",
      "q",
    ]);
    expect(result.stdout).toBe("ED_RC=0\ntw0\nthree\n0ne\nfour\n");
  }, 60_000);

  it("prints byte counts on read and write without -s", async () => {
    const result = await sh([
      "printf 'abc\\n' > /tmp/f.txt",
      "printf 'w /tmp/g.txt\\nq\\n' > /tmp/cmds",
      "ed /tmp/f.txt < /tmp/cmds",
    ].join("; "));
    expect(result.stdout).toBe("4\n4\n");
  }, 60_000);

  it("reports an invalid command with ? and a nonzero status", async () => {
    const result = await edScript("one\n", ["9d", "w", "q"]);
    expect(result.stdout).toContain("?");
    expect(result.stdout).not.toContain("ED_RC=0");
  }, 60_000);
});
