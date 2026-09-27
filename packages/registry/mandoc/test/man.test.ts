/**
 * The root filesystem installs mandoc as man(1): mandoc selects its man
 * front-end when argv[0] is "man". These cases look a page up by name
 * through MANPATH and check it comes back formatted. The replaced
 * posix-utils-lite man printed the raw roff source of
 * /usr/share/man/man<N>/<name>.<N> and ignored MANPATH.
 */
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const dash = tryResolveBinary("programs/dash.wasm");
const mandoc = tryResolveBinary("programs/mandoc.wasm");
const coreutils = tryResolveBinary("programs/coreutils.wasm");
const artifactsAvailable = !!dash && !!mandoc && !!coreutils;

const PAGE = `.Dd January 1, 2026
.Dt DEMO 1
.Os
.Sh NAME
.Nm demo
.Nd a sample page
.Sh DESCRIPTION
The demo utility does nothing.
`;

/** Quote `text` as one POSIX shell word. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

async function runMan(args: string) {
  const execPrograms = new Map<string, string>([
    ["/bin/man", mandoc!],
    ["/usr/bin/man", mandoc!],
    ["/bin/mkdir", coreutils!],
    ["/usr/bin/mkdir", coreutils!],
  ]);
  return runCentralizedProgram({
    programPath: dash!,
    argv: [
      "dash",
      "-c",
      `mkdir -p /tmp/man/man1 && printf '%s' ${shellQuote(PAGE)} > /tmp/man/man1/demo.1 && ` +
        `MANPATH=/tmp/man man ${args}`,
    ],
    // No tty on standard output, so man writes to it instead of a pager.
    env: ["PATH=/bin:/usr/bin", "HOME=/tmp"],
    execPrograms,
    timeout: 30_000,
  });
}

describe.skipIf(!artifactsAvailable)("mandoc as man", () => {
  it("finds a page through MANPATH and renders it", async () => {
    const result = await runMan("demo");
    // mandoc 1.14.6 warns whenever it finds a page by searching the
    // directory instead of through a makewhatis(8) database (main.c,
    // fs_lookup); this MANPATH has no database.
    expect(result.stderr).toBe(
      "man: outdated mandoc.db lacks demo(1) entry, run makewhatis /tmp/man\n",
    );
    expect(result.exitCode).toBe(0);
    // Bold is nroff backspace-overstrike; strip it as col -b would.
    const plain = result.stdout.replace(/.\x08/g, "");
    expect(plain).toMatch(/^NAME\n\s+demo - a sample page$/m);
    expect(plain).toContain("The demo utility does nothing.");
    expect(plain).not.toContain(".Sh");
  }, 60_000);

  it("reports a missing page with a nonzero status", async () => {
    const result = await runMan("no-such-page");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no-such-page");
  }, 60_000);
});
