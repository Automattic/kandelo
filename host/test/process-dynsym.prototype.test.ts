import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCentralizedProgram } from "./centralized-test-helper";
import { NodePlatformIO } from "../src/platform/node";

const root = join(__dirname, "../..");
const wasm64 = process.env.KANDELO_LOADER_FIXTURE_ARCH === "wasm64posix";
const fixtureDir = join(root, ".scratch", wasm64 ? "dynsym-wasm64" : "");


it.skipIf(process.env.KANDELO_PROCESS_DYNSYM_PROTOTYPE !== "1")(
  "resolves executable symbols locally and preserves their slots through fork",
  { timeout: 120_000 },
  async () => {
    const program = join(fixtureDir, "process-dynsym.wasm");
    const linked = join(fixtureDir, "process-dynsym.linked.wasm");
    const tool = join(root, "scripts/run-wasm-fork-instrument.sh");
    const report = execFileSync(tool, [linked, "--sink-report"], { encoding: "utf8" });
    expect(report.split("\n")[0], report).toBe(wasm64 ? "source\tbuiltin" : "source\tfacts");

    const module = new WebAssembly.Module(readFileSync(program));
    expect(WebAssembly.Module.imports(module).filter(({ name }) => /^__wasm_dl/.test(name)))
      .toEqual([]);
    const capability = execFileSync(tool, [program, "--fork-capability-hex"], {
      encoding: "utf8",
    });
    expect(capability.trim()).toMatch(/0104$/);

    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["process-dynsym"],
      timeout: 30_000,
      useDefaultRootfs: false,
      io: new NodePlatformIO(),
    });
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toBe("before fork\nguest dynsym fork ok\n");
    expect(result.stderr).toBe("");
  },
);

it.skipIf(process.env.KANDELO_PROCESS_DYNSYM_PROTOTYPE !== "1").each([
  { side: "process-dynsym-side.so", needed: false },
  { side: "dynsym-needed-consumer.so", needed: true },
])(
  "maps $side and forks with and within it",
  { timeout: 120_000 },
  async ({ side, needed }) => {
    const programPath = join(fixtureDir, "process-dynsym-mapped.wasm");
    const module = new WebAssembly.Module(readFileSync(programPath));
    const imports = WebAssembly.Module.imports(module);
    expect(imports.filter(({ name }) => /^__wasm_dl/.test(name))).toEqual([]);
    expect(imports).toContainEqual({
      module: "kandelo.loader.v1",
      name: "__kandelo_map_module_v1",
      kind: "function",
    });

    const path = "/lib/dynsym-fixture.so";
    const execPrograms = new Map([[path, join(fixtureDir, side)]]);
    if (needed) execPrograms.set("/lib/dynsym-dependency.so", join(fixtureDir, "dynsym-dependency.so"));
    const result = await runCentralizedProgram({
      programPath,
      argv: ["process-dynsym", path, ...(needed ? ["dependency"] : [])],
      execPrograms,
      useDefaultRootfs: false,
      timeout: 30_000,
    });
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toBe("before fork\nbefore plugin fork\nguest dynsym fork ok\n");
    expect(result.stderr).toBe("");
    expect(result.hostDiagnostics).toEqual([]);
  },
);

it.skipIf(!process.env.KANDELO_ABI56_LOADER_FIXTURE)(
  "loads a previously built ABI-56 plugin and calls it in the fork child",
  { timeout: 120_000 },
  async () => {
    const fixture = process.env.KANDELO_ABI56_LOADER_FIXTURE!;
    const programPath = join(fixture, "plugin-host.wasm");
    const pluginPath = "/lib/scaled-dynsym.so";
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(programPath)));
    expect(imports).toContainEqual({ module: "env", kind: "function", name: "__wasm_dlopen_prepare" });
    const result = await runCentralizedProgram({
      programPath,
      argv: ["scaled-dynsym", pluginPath],
      execPrograms: new Map([[pluginPath, join(fixture, "plugin.so")]]),
      useDefaultRootfs: false,
      forkCopy: "sparse",
      timeout: 30_000,
    });
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toMatch(/^\d+ \d+ \d+ \d+\n$/);
    expect(result.stderr).toBe("");
    expect(result.hostDiagnostics).toEqual([]);
  },
);

it.skipIf(process.env.KANDELO_PROCESS_DYNSYM_PROTOTYPE !== "1")(
  "serializes named loads and closes, including nested initialization",
  { timeout: 120_000 },
  async () => {
    const plugin = "/lib/dynsym-lifecycle.so";
    const result = await runCentralizedProgram({
      programPath: join(fixtureDir, "process-dynsym-lifecycle.wasm"),
      argv: ["dynsym-lifecycle", plugin],
      execPrograms: new Map([
        [plugin, join(fixtureDir, "dynsym-lifecycle.so")],
        ["/lib/dynsym-dependency.so", join(fixtureDir, "dynsym-dependency.so")],
      ]),
      useDefaultRootfs: false,
      timeout: 45_000,
    });
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toBe("guest loader lifecycle ok\n");
    expect(result.stderr).toBe("");
    expect(result.hostDiagnostics).toEqual([]);
  },
);
