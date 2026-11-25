import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCentralizedProgram } from "./centralized-test-helper";
import { NodePlatformIO } from "../src/platform/node";

const root = join(__dirname, "../..");

it.skipIf(process.env.KANDELO_PROCESS_DYNSYM_PROTOTYPE !== "1")(
  "resolves executable symbols locally and preserves their slots through fork",
  { timeout: 120_000 },
  async () => {
    const program = join(root, ".scratch/process-dynsym.wasm");
    const linked = join(root, ".scratch/process-dynsym.linked.wasm");
    const tool = join(root, "scripts/run-wasm-fork-instrument.sh");
    const report = execFileSync(tool, [linked, "--sink-report"], { encoding: "utf8" });
    expect(report.split("\n")[0], report).toBe("source\tfacts");

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
      io: new NodePlatformIO(),
    });
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toBe("before fork\nguest dynsym fork ok\n");
    expect(result.stderr).toBe("");
  },
);

it.skipIf(process.env.KANDELO_PROCESS_DYNSYM_PROTOTYPE !== "1")(
  "maps a guest-bound plugin and forks with and within it",
  { timeout: 120_000 },
  async () => {
    const programPath = join(root, ".scratch/process-dynsym-mapped.wasm");
    const module = new WebAssembly.Module(readFileSync(programPath));
    const imports = WebAssembly.Module.imports(module);
    expect(imports.filter(({ name }) => /^__wasm_dl/.test(name))).toEqual([]);
    expect(imports).toContainEqual({
      module: "kandelo.loader.prototype.v1",
      name: "__kandelo_map_module_v1",
      kind: "function",
    });

    const result = await runCentralizedProgram({
      programPath,
      argv: ["process-dynsym", "/lib/dynsym-fixture.so"],
      execPrograms: new Map([["/lib/dynsym-fixture.so", join(root, ".scratch/process-dynsym-side.so")]]),
      useDefaultRootfs: false,
      timeout: 30_000,
    });
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toBe("before fork\nbefore plugin fork\nguest dynsym fork ok\n");
    expect(result.stderr).toBe("");
    expect(result.hostDiagnostics).toEqual([]);
  },
);
