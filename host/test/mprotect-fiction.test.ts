import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readWasmCustomSectionPayload } from "../src/constants";
import { runCentralizedProgram } from "./centralized-test-helper";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const source = join(repoRoot, "examples/mprotect_fiction_test.c");
const forkInstrument = join(repoRoot, "scripts/run-wasm-fork-instrument.sh");

type Arch = "wasm32" | "wasm64";

function compile(
  arch: Arch,
  args: string[],
  env: Record<string, string> = {},
  input = source,
) {
  const out = join(mkdtempSync(join(tmpdir(), "mprotect-fiction-")), "t.wasm");
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  if (!("KANDELO_FICTIONS" in env)) delete childEnv.KANDELO_FICTIONS;
  const result = spawnSync(join(repoRoot, `sdk/bin/${arch}posix-cc`),
    [input, "-o", out, ...args], { encoding: "utf8", env: childEnv });
  return { out, ...result };
}

function stamp(path: string): string | null {
  const bytes = readFileSync(path);
  const payload = readWasmCustomSectionPayload(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    "kandelo.fictions",
  );
  return payload === null ? null : new TextDecoder().decode(payload);
}

async function run(path: string) {
  return runCentralizedProgram({
    programPath: path,
    argv: ["mprotect-fiction-test"],
    useDefaultRootfs: false,
    timeout: 30_000,
  });
}

const PROT_NONE_GUARDS =
  "mprotect:prot_none=accept-unenforced,prot_none_max=65536,read_only=enotsup,read_only_max=0\n";

// A declared fiction makes chosen classes of restrictive mprotect request
// report success without effect (sdk/fictions/mprotect.toml). These build the
// guest program for each selection with the expectations it must observe; the
// program checks every class and limit, that access is unchanged, and that
// the kernel logged one record when it accepted a restrictive request.
describe("declared mprotect fiction", () => {
  const cases: {
    name: string;
    args: string[];
    env?: Record<string, string>;
    expect: string[];
    stamp: string | null;
  }[] = [
    {
      name: "truthful subset only (-lkandelo-mprotect)",
      args: ["-lkandelo-mprotect"],
      expect: [],
      stamp: null,
    },
    {
      name: "prot_none accepted up to one page (flag)",
      args: ["--kandelo-fiction=mprotect:prot_none=accept-unenforced,prot_none_max=65536"],
      expect: ["-DEXPECT_PROT_NONE=1", "-DEXPECT_PROT_NONE_MAX=65536"],
      stamp: PROT_NONE_GUARDS,
    },
    {
      name: "read_only accepted without limit (environment)",
      args: [],
      env: { KANDELO_FICTIONS: "mprotect:read_only=accept-unenforced" },
      expect: ["-DEXPECT_READ_ONLY=1"],
      stamp:
        "mprotect:prot_none=enotsup,prot_none_max=0,read_only=accept-unenforced,read_only_max=0\n",
    },
    {
      name: "both classes, read_only up to two pages, over a caller's own -lkandelo-mprotect",
      args: [
        "-lkandelo-mprotect",
        "--kandelo-fiction=mprotect:prot_none=accept-unenforced,read_only=accept-unenforced,read_only_max=131072",
      ],
      expect: ["-DEXPECT_PROT_NONE=1", "-DEXPECT_READ_ONLY=1", "-DEXPECT_READ_ONLY_MAX=131072"],
      stamp:
        "mprotect:prot_none=accept-unenforced,prot_none_max=0,read_only=accept-unenforced,read_only_max=131072\n",
    },
  ];

  for (const arch of ["wasm32", "wasm64"] as const) {
    for (const c of cases) {
      it(`${c.name} (${arch})`, async () => {
        const link = compile(arch, [...c.args, ...c.expect], c.env);
        expect(link.stderr).toBe("");
        expect(link.status).toBe(0);
        expect(stamp(link.out)).toBe(c.stamp);
        const result = await run(link.out);
        expect(result.stdout).toContain("MPROTECT_FICTION_PASS");
        expect(result.exitCode).toBe(0);
      }, 60_000);
    }
  }

  it("keeps the stamp through fork instrumentation, and the instrumented program runs", async () => {
    const link = compile("wasm32", [
      "--kandelo-fiction=mprotect:prot_none=accept-unenforced,prot_none_max=65536",
      "-DEXPECT_PROT_NONE=1",
      "-DEXPECT_PROT_NONE_MAX=65536",
      "-DWITH_FORK",
    ]);
    expect(link.stderr).toBe("");
    expect(link.status).toBe(0);
    const instrumented = join(dirname(link.out), "instrumented.wasm");
    const result = spawnSync(forkInstrument, [link.out, "-o", instrumented],
      { cwd: repoRoot, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(stamp(instrumented)).toBe(PROT_NONE_GUARDS);
    const run1 = await run(instrumented);
    expect(run1.stdout).toContain("MPROTECT_FICTION_PASS");
    expect(run1.exitCode).toBe(0);
  }, 120_000);

  it("stamps nothing into a program that never calls mprotect", () => {
    const dir = mkdtempSync(join(tmpdir(), "mprotect-fiction-none-"));
    const hello = join(dir, "hello.c");
    writeFileSync(hello, "#include <stdio.h>\nint main(void) { puts(\"hi\"); return 0; }\n");
    const link = compile("wasm32", [], {
      KANDELO_FICTIONS: "mprotect:prot_none=accept-unenforced",
    }, hello);
    expect(link.stderr).toBe("");
    expect(link.status).toBe(0);
    expect(stamp(link.out)).toBeNull();
  });

  it("refuses an invalid or truthful selection", () => {
    for (const [selection, message] of [
      ["mprotect:prot_none=yes", "must be one of enotsup, accept-unenforced"],
      ["mmap:x=1", "unknown fiction"],
      ["mprotect", "departs from no truthful default"],
      ["mprotect:read_only=accept-unenforced,prot_none_max=65536", "bounds what prot_none accepts"],
    ]) {
      const link = compile("wasm32", [`--kandelo-fiction=${selection}`]);
      expect(link.status).not.toBe(0);
      expect(link.stderr).toContain(message);
    }
  });
});
