/**
 * SPIKE PROTOTYPE (brandonpayton/shared-lib-exec-spike): an executable linked
 * against a shared library with `cc main.o -L dir -lfoo`, loaded at startup.
 * See host/src/main-dynamic-imports.ts and crates/kandelo-cc/src/dynlink.rs.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  makeHostScratchTempRoot,
  runCentralizedProgram,
} from "./centralized-test-helper";
import { NodePlatformIO } from "../src/platform/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const CC = join(REPO_ROOT, "sdk/bin/wasm32posix-cc");
const BUILD_DIR = makeHostScratchTempRoot("spike-shared-lib-exec-");
const LIB_DIR = join(BUILD_DIR, "lib");
const OTHER_DIR = join(BUILD_DIR, "elsewhere");
const SRC = join(__dirname, "fixtures/spike-shared-lib-exec");
// Prebuilt by fixtures/spike-shared-lib-exec/build.sh.
const PREBUILT = join(REPO_ROOT, ".scratch/spike-e2e");

function cc(args: string[]): void {
  execFileSync(CC, args, { stdio: "pipe", cwd: BUILD_DIR });
}

describe("spike: executable linked against a shared library", () => {
  const io = () => new NodePlatformIO();

  beforeAll(() => {
    mkdirSync(LIB_DIR, { recursive: true });
    mkdirSync(OTHER_DIR, { recursive: true });
    for (const f of ["foo.c", "main.c"]) copyFileSync(join(SRC, f), join(BUILD_DIR, f));
    cc(["-shared", "-fPIC", "-O2", "-DNO_LIB_FORK", "foo.c", "-o", join(LIB_DIR, "libfoo.so")]);
    cc(["-O2", "-fPIC", "-c", "main.c", "-o", "main.o"]);
    cc(["-O2", "main.o", "-L", LIB_DIR, "-lfoo", `-Wl,-rpath,${LIB_DIR}`, "-o", "main-rpath.wasm"]);
    cc(["-O2", "main.o", "-L", LIB_DIR, "-lfoo", "-o", "main-norpath.wasm"]);
    cc(["-O2", "-DNO_LIB_FORK", "main.o", "foo.c", "-o", "main-static.wasm"]);
    copyFileSync(join(LIB_DIR, "libfoo.so"), join(OTHER_DIR, "libfoo.so"));
  }, 120_000);

  it("runs with the library found through the link-time run path", { timeout: 60_000 }, async () => {
    const result = await runCentralizedProgram({
      programPath: join(BUILD_DIR, "main-rpath.wasm"),
      argv: ["main"],
      timeout: 20_000,
      io: io(),
    });
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      "main: lib ctor ran before main: 1\n" +
        "libfoo: foo(1) counter=42 sorted=123\n" +
        "libfoo: foo(2) counter=42 sorted=123\n" +
        "main: foo(1)=43 via pointer=44 apply=42\n",
    );
    expect(result.exitCode).toBe(0);
  });

  it("finds the library through LD_LIBRARY_PATH", { timeout: 60_000 }, async () => {
    const result = await runCentralizedProgram({
      programPath: join(BUILD_DIR, "main-norpath.wasm"),
      argv: ["main"],
      env: [`LD_LIBRARY_PATH=/nonexistent:${OTHER_DIR}`],
      timeout: 20_000,
      io: io(),
    });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("fails like ld.so when a needed library is missing", { timeout: 60_000 }, async () => {
    const result = await runCentralizedProgram({
      programPath: join(BUILD_DIR, "main-norpath.wasm"),
      argv: ["main"],
      timeout: 20_000,
      io: io(),
    });
    expect(result.stderr).toContain(
      "error while loading shared libraries: libfoo.so: cannot open shared object file",
    );
    expect(result.exitCode).toBe(127);
  });

  // Prebuilt (fork-instrumented); see PREBUILT.
  it("forks from the executable after startup loading", { timeout: 60_000 }, async () => {
    const result = await runCentralizedProgram({
      programPath: join(PREBUILT, "forkmain-a.wasm"),
      argv: ["forkmain"],
      timeout: 20_000,
      io: io(),
    });
    console.log("SPIKE-FORK-MAIN", JSON.stringify(result));
    expect(result.stdout).toContain("child: foo(1)=102");
    expect(result.stdout).toContain("parent: child status=7 counter=100 foo(1)=101");
    expect(result.exitCode).toBe(0);
  });

  // KNOWN BOUNDARY: the executable calls the library through a direct import;
  // the fork instrumenter treats that call as an ordinary import, so the
  // child cannot rewind across it ("activation 0 cannot consume frame for
  // activation 1"). The pointer variant below works.
  it.fails("forks from inside the shared library", { timeout: 60_000 }, async () => {
    const result = await runCentralizedProgram({
      programPath: join(PREBUILT, "forkmain-b.wasm"),
      argv: ["forkmain", "lib"],
      timeout: 20_000,
      io: io(),
    });
    console.log("SPIKE-FORK-LIB", JSON.stringify(result));
    expect(result.stdout).toContain("lib child: foo(5)=105");
    expect(result.stdout).toContain("parent: lib-fork child status=3");
    expect(result.exitCode).toBe(0);
  });

  it("forks from inside the shared library reached through a pointer", { timeout: 60_000 }, async () => {
    const result = await runCentralizedProgram({
      programPath: join(PREBUILT, "forkmain-c.wasm"),
      argv: ["forkmain", "lib"],
      timeout: 20_000,
      io: io(),
    });
    console.log("SPIKE-FORK-PTR", JSON.stringify({ ...result, stdoutBytes: undefined }));
    expect(result.stdout).toContain("lib child: foo(5)=105");
    expect(result.stdout).toContain("parent: lib-fork child status=3");
    expect(result.exitCode).toBe(0);
  });

  // Prebuilt 4000-function (~1 MB) library; see PREBUILT.
  it("measures a large library and per-call cost", { timeout: 300_000 }, async () => {
    const samples: Record<string, { ms: number[]; ns: number[] }> = {};
    for (let round = 0; round < 6; round++) {
      for (const program of ["bigmain-static.wasm", "bigmain-dyn.wasm"]) {
        const start = performance.now();
        const r = await runCentralizedProgram({
          programPath: join(PREBUILT, program),
          argv: ["bigmain"],
          timeout: 60_000,
          io: io(),
        });
        const ms = performance.now() - start;
        expect(r.exitCode, r.stderr).toBe(0);
        const ns = Number(/tiny_ns_per_call=([0-9.]+)/.exec(r.stdout)![1]);
        if (round === 0) continue; // warm-up
        (samples[program] ??= { ms: [], ns: [] }).ms.push(ms);
        samples[program]!.ns.push(ns);
      }
    }
    const median = (s: number[]) => [...s].sort((a, b) => a - b)[Math.floor(s.length / 2)]!;
    const report = Object.fromEntries(
      Object.entries(samples).map(([k, v]) => [
        k,
        { startupMedianMs: median(v.ms).toFixed(1), tinyNsPerCallMedian: median(v.ns).toFixed(3) },
      ]),
    );
    writeFileSync(join(REPO_ROOT, ".scratch/spike-e2e/measure-big.json"), JSON.stringify(report, null, 2));
    console.log("SPIKE-MEASURE-BIG", JSON.stringify(report));
  });

  it("measures startup against the static link", { timeout: 300_000 }, async () => {
    const sizes = Object.fromEntries(
      ["main-rpath.wasm", "main-static.wasm", "lib/libfoo.so"].map((f) => [
        f,
        statSync(join(BUILD_DIR, f)).size,
      ]),
    );
    const runs = 10;
    const time = async (program: string): Promise<number[]> => {
      const samples: number[] = [];
      for (let i = 0; i < runs; i++) {
        const start = performance.now();
        const r = await runCentralizedProgram({
          programPath: join(BUILD_DIR, program),
          argv: ["main"],
          timeout: 20_000,
          io: io(),
        });
        samples.push(performance.now() - start);
        expect(r.exitCode).toBe(0);
      }
      return samples.sort((a, b) => a - b);
    };
    // Interleave warm-up so neither variant gets a cold cache advantage.
    await time("main-static.wasm");
    const dynamic = await time("main-rpath.wasm");
    const stat = await time("main-static.wasm");
    const median = (s: number[]) => s[Math.floor(s.length / 2)]!;
    const report = {
      sizes,
      runs,
      staticMedianMs: median(stat).toFixed(1),
      dynamicMedianMs: median(dynamic).toFixed(1),
      staticMinMs: stat[0]!.toFixed(1),
      dynamicMinMs: dynamic[0]!.toFixed(1),
    };
    writeFileSync(join(REPO_ROOT, ".scratch/spike-e2e/measure.json"), JSON.stringify(report, null, 2));
    console.log("SPIKE-MEASURE", JSON.stringify(report));
  });
});
