/**
 * locale(1) must report the locale the process is actually in. The
 * replaced posix-utils-lite locale printed a fixed list of names.
 *
 * Known upstream deviation (docs/posix-status.md): musl-locales 0.1.0
 * builds its category report from LC_ALL and LANG only, so it ignores
 * individual LC_* variables and does not quote implied values. These cases
 * cover what it reports correctly.
 */
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const dash = tryResolveBinary("programs/dash.wasm");
const coreutils = tryResolveBinary("programs/coreutils.wasm");
const locale = tryResolveBinary("programs/locale.wasm");
const programs: Record<string, string | null> = {
  cat: coreutils,
  ls: coreutils,
  mkdir: coreutils,
  od: coreutils,
  cmp: tryResolveBinary("programs/diffutils/cmp.wasm"),
  grep: tryResolveBinary("programs/grep.wasm"),
  locale,
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

describe.skipIf(!artifactsAvailable)("musl-locales locale", () => {
  it("reports LC_ALL and the character map of the current locale", async () => {
    const result = await sh(
      "LC_ALL=C.UTF-8 locale; echo ---; LC_ALL=C.UTF-8 locale charmap; LC_ALL=C locale charmap",
    );
    expect(result.exitCode).toBe(0);
    const [report, charmaps] = result.stdout.split("---\n");
    expect(report).toContain("LC_CTYPE=C.UTF-8");
    expect(report).toMatch(/^LC_ALL=C\.UTF-8$/m);
    expect(charmaps).toBe("UTF-8\nASCII\n");
  }, 60_000);

  it("prints the value of a keyword with -k", async () => {
    const result = await sh("LC_ALL=C locale -k decimal_point");
    expect(result.stdout).toBe('decimal_point="."\n');
  }, 60_000);
});
