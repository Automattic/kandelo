/**
 * getconf must report the values the platform's sysconf(), pathconf() and
 * confstr() return, and fail for names it does not know. The replaced
 * posix-utils-lite getconf knew a handful of names and printed invented
 * fallbacks.
 */
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const dash = tryResolveBinary("programs/dash.wasm");
const coreutils = tryResolveBinary("programs/coreutils.wasm");
const getconf = tryResolveBinary("programs/getconf.wasm");
const programs: Record<string, string | null> = {
  cat: coreutils,
  cp: coreutils,
  od: coreutils,
  wc: coreutils,
  cmp: tryResolveBinary("programs/diffutils/cmp.wasm"),
  getconf,
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

describe.skipIf(!artifactsAvailable)("Alpine getconf", () => {
  it("reports sysconf, pathconf, and confstr values", async () => {
    const result = await sh([
      "getconf PAGESIZE",
      "getconf NAME_MAX /",
      "getconf LINE_MAX",
      "getconf PATH",
    ].join("; "));
    expect(result.exitCode).toBe(0);
    const [pagesize, nameMax, lineMax, path] = result.stdout.trim().split("\n");
    // docs/posix-status.md: _SC_PAGE_SIZE is the Wasm page, 65536; the
    // common path resolver reports _PC_NAME_MAX=255.
    expect(pagesize).toBe("65536");
    expect(nameMax).toBe("255");
    // musl's sysconf(_SC_LINE_MAX) is -1 (no fixed limit;
    // libc/musl/src/conf/sysconf.c), and POSIX getconf prints "undefined"
    // for an indeterminate value rather than inventing one.
    expect(lineMax).toBe("undefined");
    expect(path).toMatch(/(^|:)\/bin(:|$)/);
  }, 60_000);

  it("fails for an unknown name", async () => {
    const result = await sh("getconf NO_SUCH_CONFIG_NAME; echo RC=$?");
    expect(result.stdout).not.toContain("RC=0");
    expect(result.stderr).not.toBe("");
  }, 60_000);
});
