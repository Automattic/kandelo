/**
 * Plugin modules built with the build machine's SDK.
 *
 * A program loads a plugin side module with dlopen(3); the plugin calls back
 * into the program and into libc. The same program and plugin build natively
 * inside Kandelo with Libtool, CMake and Meson in guest-plugins.test.ts.
 * These cases pin the SDK contract docs/sdk-guide.md describes under
 * "Plugin modules": a program that calls dlopen gets the loader without
 * -ldl, -rdynamic exports the program's symbols and the libc functions it
 * links, exporting does not make the program fork-capable, and a program
 * that never calls dlopen is unaffected.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const CXX = join(REPO_ROOT, "sdk/bin/wasm32posix-c++");
const BUILD_DIR = makeHostScratchTempRoot("sdk-plugin-modules-");
const loaderImport = "kandelo.loader.v1.__kandelo_map_module_v1";
const pluginOutput = "plugin: host_scale=3\nplugin_run(7) = 22\n";

const hasSysroot = existsSync(join(REPO_ROOT, "sysroot", "lib", "libc.a"));
const hasKernel = tryResolveBinary("kernel.wasm") !== null;

function link(name: string, source: string, flags: string[]): string {
  const program = join(BUILD_DIR, `${name}.wasm`);
  execFileSync(CC, ["-O2", source, ...flags, "-o", program], { stdio: "pipe" });
  return program;
}

function buildPlugin(source: string, compiler = CC, flags = ["-O2"]): string {
  const module = join(BUILD_DIR, source.replace(/\.(c|cpp)$/, ".so"));
  execFileSync(compiler, ["-shared", "-fPIC", ...flags, join(FIXTURE, source), "-o", module], { stdio: "pipe" });
  return module;
}

function imports(program: string): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(program)))
    .map((i) => `${i.module}.${i.name}`);
}

function exports(program: string): string[] {
  return WebAssembly.Module.exports(new WebAssembly.Module(readFileSync(program)))
    .map((e) => e.name);
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
  const hostSource = join(FIXTURE, "host.c");
  let plugin = "";
  let host = "";
  beforeAll(() => {
    mkdirSync(BUILD_DIR, { recursive: true });
    plugin = buildPlugin("plugin.c");
    // As on Unix: -rdynamic, and no -ldl.
    host = link("host", hostSource, ["-rdynamic"]);
  }, 120_000);

  it("a program linked with -rdynamic and no -ldl loads a plugin that calls it and libc", { timeout: 60_000 }, async () => {
    const result = await run(host, plugin);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(pluginOutput);
    expect(result.exitCode).toBe(0);
  });

  it("-Wl,--export-dynamic exports the same symbols as -rdynamic", { timeout: 60_000 }, async () => {
    const exportDynamic = link("host-export-dynamic", hostSource, ["-Wl,--export-dynamic"]);
    expect(exports(exportDynamic).sort()).toEqual(exports(host).sort());
    const result = await run(exportDynamic, plugin);
    expect(result.stdout).toBe(pluginOutput);
    expect(result.exitCode).toBe(0);
  });

  // A link that names libc itself (librsvg's pkg-config file adds -lc) must
  // still get the loader, not musl's "Dynamic loading not supported" stubs.
  it("a program linked with its own -lc still gets the loader", { timeout: 60_000 }, async () => {
    const withLibc = link("host-lc", hostSource, ["-rdynamic", "-lc"]);
    expect(imports(withLibc)).toContain(loaderImport);
    const result = await run(withLibc, plugin);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(pluginOutput);
    expect(result.exitCode).toBe(0);
  });

  // Autoconf's AC_CHECK_FUNC declares the function with the wrong
  // signature. The link must still produce a valid module, or every
  // configure script decides dlopen is missing.
  it("an Autoconf-style dlopen probe links to a valid module", { timeout: 60_000 }, () => {
    const source = join(BUILD_DIR, "probe.c");
    writeFileSync(source, "char dlopen (void);\nint main (void) { return dlopen (); }\n");
    for (const flags of [[], ["-ldl"], ["-lc"]]) {
      const program = link(`probe${flags.join("")}`, source, flags);
      expect(WebAssembly.validate(readFileSync(program)), `${flags}`).toBe(true);
    }
  });

  it("exports the program's symbols and the libc it links, but not the platform glue", { timeout: 60_000 }, () => {
    const names = exports(host);
    for (const name of ["host_callback", "host_scale", "printf", "dlopen", "dlsym"]) {
      expect(names, name).toContain(name);
    }
    // The glue's fork entry and syscall channel stay private, so exporting
    // does not keep fork, or the kernel's fork import, in this program.
    for (const name of ["fork", "_Fork", "vfork", "__syscall3"]) {
      expect(names, name).not.toContain(name);
    }
    expect(imports(host)).not.toContain("kernel.kernel_fork");
    expect(imports(host)).toContain(loaderImport);
  });

  it("a program that never calls dlopen gets none of the loader, with or without -ldl", { timeout: 120_000 }, () => {
    const source = join(BUILD_DIR, "hello.c");
    writeFileSync(source, '#include <stdio.h>\nint main(void) { puts("hello"); return 0; }\n');
    // (-ldl still keeps the host's default thread-slot declaration, as a
    // hint that the program may load modules, so the bytes can differ.)
    for (const flags of [[], ["-ldl"]]) {
      const program = link(`hello${flags.join("")}`, source, flags);
      expect(imports(program), `${flags}`).not.toContain(loaderImport);
      expect(exports(program), `${flags}`).not.toContain("dlopen");
    }
  });

  // A side module's own vague-linkage definitions (inline functions, inline
  // virtual members, template members) must bind to its own copies. With
  // default visibility, wasm-ld imports a module's weak definitions instead,
  // which the loader cannot satisfy: ScummVM's engines stopped loading that
  // way. Position-independent compiles therefore keep hidden visibility.
  it("a C++ plugin binds its own inline, virtual and template definitions", { timeout: 120_000 }, async () => {
    const pluginCxx = buildPlugin("plugin-cxx.cpp", CXX, ["-O0", "-fno-rtti"]);
    const own = new Set(exports(pluginCxx));
    const fromProgram = WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(pluginCxx)))
      .filter((i) => i.module === "env" && i.kind === "function")
      .map((i) => i.name);
    expect(fromProgram.filter((name) => own.has(name))).toEqual([]);
    expect(fromProgram.sort()).toEqual(["host_callback", "printf"]);

    const result = await run(host, pluginCxx);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("plugin-cxx: area=49\nplugin_run(7) = 42\n");
    expect(result.exitCode).toBe(0);
  });

  // A plugin takes libc from the program, so a libc function the program
  // never links is not there to export.
  it("a plugin calling libc the program does not link loads once the program exports it", { timeout: 60_000 }, async () => {
    const pluginLibc = buildPlugin("plugin-libc.c");
    const refused = await run(host, pluginLibc);
    expect(refused.stderr).toMatch(/^dlopen: .*strverscmp/);
    expect(refused.exitCode).toBe(1);

    const exporting = link("host-strverscmp", hostSource, ["-rdynamic", "-Wl,--export=strverscmp"]);
    const loaded = await run(exporting, pluginLibc);
    expect(loaded.stderr).toBe("");
    expect(loaded.stdout).toBe("plugin_run(7) = 8\n");
    expect(loaded.exitCode).toBe(0);
  });
});
