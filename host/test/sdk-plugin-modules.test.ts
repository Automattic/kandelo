/**
 * Plugin modules built with the build machine's SDK.
 *
 * A program loads a plugin side module with dlopen(3); the plugin calls back
 * into the program. The same program and plugin build natively inside
 * Kandelo with Libtool, CMake and Meson in guest-plugins.test.ts. These
 * cases also pin the boundaries docs/sdk-guide.md describes under "Plugin
 * modules": libc's symbols are hidden, -ldl links the loader, and
 * --export-all makes a program fork-capable.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeHostScratchTempRoot,
  runCentralizedProgram,
} from "./centralized-test-helper";
import { NodePlatformIO } from "../src/platform/node";
import { tryResolveBinary } from "../src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const FIXTURE = join(__dirname, "fixtures/guest-build/plugins");
const CC = join(REPO_ROOT, "sdk/bin/wasm32posix-cc");
const BUILD_DIR = makeHostScratchTempRoot("sdk-plugin-modules-");

const hasSysroot = existsSync(join(REPO_ROOT, "sysroot", "lib", "libc.a"));
const hasKernel = tryResolveBinary("kernel.wasm") !== null;

function buildHost(name: string, flags: string[]): string {
  const program = join(BUILD_DIR, `${name}.wasm`);
  execFileSync(CC, ["-O2", join(FIXTURE, "host.c"), ...flags, "-o", program], { stdio: "pipe" });
  return program;
}

function buildPlugin(source: string): string {
  const module = join(BUILD_DIR, source.replace(/\.c$/, ".so"));
  execFileSync(CC, ["-shared", "-fPIC", "-O2", join(FIXTURE, source), "-o", module], { stdio: "pipe" });
  return module;
}

function run(program: string, module: string) {
  return runCentralizedProgram({
    programPath: program,
    argv: ["host", module],
    timeout: 20_000,
    io: new NodePlatformIO(),
  });
}

describe.skipIf(!hasSysroot || !hasKernel || !existsSync(CC))("SDK plugin modules", () => {
  let plugin = "";
  let pluginLibc = "";
  let host = "";
  beforeAll(() => {
    mkdirSync(BUILD_DIR, { recursive: true });
    plugin = buildPlugin("plugin.c");
    pluginLibc = buildPlugin("plugin-libc.c");
    host = buildHost("host", ["-ldl", "-Wl,--export-dynamic"]);
  }, 120_000);

  it("loads a plugin that calls the program's exported API", { timeout: 60_000 }, async () => {
    const result = await run(host, plugin);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("plugin: host_scale=3\nplugin_run(7) = 22\n");
    expect(result.exitCode).toBe(0);
  });

  // libc's symbols are hidden, so --export-dynamic does not export printf.
  it("refuses a plugin that calls a libc function the program does not export", { timeout: 60_000 }, async () => {
    const result = await run(host, pluginLibc);
    expect(result.stderr).toMatch(/^dlopen: .*"printf"/);
    expect(result.exitCode).toBe(1);
  });

  it("loads that plugin once the program exports printf", { timeout: 60_000 }, async () => {
    const exportsPrintf = buildHost("host-printf", ["-ldl", "-Wl,--export-dynamic", "-Wl,--export=printf"]);
    const result = await run(exportsPrintf, pluginLibc);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("plugin-libc: 7\nplugin_run(7) = 8\n");
    expect(result.exitCode).toBe(0);
  });

  // libc.a's dlopen is musl's static stub; -ldl links Kandelo's loader.
  it("without -ldl, dlopen is musl's static stub", { timeout: 60_000 }, async () => {
    const result = await run(buildHost("host-no-ldl", ["-Wl,--export-dynamic"]), plugin);
    expect(result.stderr).toBe("dlopen: Dynamic loading not supported\n");
    expect(result.exitCode).toBe(1);
  });

  // --export-all exports libc too, but keeps every function of each linked
  // object, the SDK glue's fork among them: the program imports the fork
  // entry and must be fork-instrumented before it can run.
  it("--export-all makes the program fork-capable", () => {
    const program = buildHost("host-export-all", ["-ldl", "-Wl,--export-all"]);
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(program)));
    expect(imports.some((i) => i.module === "kernel" && i.name === "kernel_fork")).toBe(true);
    const plain = WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(host)));
    expect(plain.some((i) => i.module === "kernel" && i.name === "kernel_fork")).toBe(false);
  }, 60_000);
});
