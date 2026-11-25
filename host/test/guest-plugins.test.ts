import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { tryResolveBinary } from "../src/binary-resolver";
import { runGuestBuild } from "../src/node-guest-build";

// Each build system builds, natively inside Kandelo, a program and a plugin
// module the program loads with dlopen(3). The plugin calls back into the
// program and into libc, which the program exports. Programs still cannot
// be linked against shared libraries: Libtool builds ordinary libraries
// static, CMake refuses SHARED under CMP0164, and Meson refuses to link a
// program against a shared library.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures/guest-build/plugins");
const kernelPath = tryResolveBinary("kernel.wasm");
const imagePath = tryResolveBinary("programs/kandelo-build-image.vfs.zst");
const available = kernelPath !== null && imagePath !== null;

const pluginOutput = "plugin: host_scale=3\nplugin_run(7) = 22\n";

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function build(name: string, script: string[], logs: string[]) {
  const dir = mkdtempSync(join(tmpdir(), `kandelo-plugins-${name}-`));
  workspaces.push(dir);
  cpSync(fixture, dir, { recursive: true });
  let log = "";
  const { exitCode } = await runGuestBuild({
    kernelWasm: new Uint8Array(readFileSync(kernelPath!)),
    image: new Uint8Array(readFileSync(imagePath!)),
    request: {
      workspace: dir,
      argv: ["/bin/sh", "-c", ["set -eu", ...script].join("\n")],
      sourceDateEpoch: 1704067200,
      timeoutMs: 1_500_000,
    },
    log: (chunk) => { log += new TextDecoder().decode(chunk); },
  });
  const read = (file: string) => {
    try { return readFileSync(join(dir, file), "utf8"); } catch { return "(missing)"; }
  };
  const detail = `${log}\n` + logs
    .map((file) => `--- ${file}\n${read(file).slice(-4000)}`).join("\n");
  return { dir, exitCode, read, detail, exists: (file: string) => existsSync(join(dir, file)) };
}

describe.skipIf(!available)("Plugin modules inside Kandelo (Node host, build image)", () => {
  it("Libtool builds a -module as a side module the program dlopens", async () => {
    const r = await build("libtool", [
      "autoreconf -fi > autoreconf.log 2>&1",
      "./configure > configure.log 2>&1",
      "make > make.log 2>&1",
      "./host .libs/greet.so > run.out",
      "make install DESTDIR=$PWD/stage > install.log 2>&1",
      "ls stage/usr/local/lib stage/usr/local/lib/kandelo-plugins > installed.list",
    ], ["autoreconf.log", "configure.log", "make.log", "install.log"]);
    expect(r.exitCode, r.detail).toBe(0);

    const configureLog = r.read("configure.log");
    expect(configureLog).toMatch(/checking dynamic linker characteristics\.\.\. Kandelo dlopen \(modules only\)/);
    expect(configureLog).toMatch(/checking whether to build shared libraries\.\.\. yes/);
    // libc provides dlopen, as on any Unix: the SDK links its loader into a
    // program that calls it, so the probe needs no -ldl.
    expect(configureLog).toMatch(/checking for library containing dlopen\.\.\. none required/);
    expect(r.read("run.out")).toBe(pluginOutput);
    // The module is a shared side module; the ordinary library is static.
    expect(r.exists(".libs/greet.so")).toBe(true);
    expect(r.exists(".libs/libcounter.a")).toBe(true);
    expect(r.exists(".libs/libcounter.so")).toBe(false);
    expect(r.read("installed.list")).toMatch(/^libcounter\.a$/m);
    expect(r.read("installed.list")).not.toMatch(/libcounter\.so/);
    expect(r.read("installed.list")).toMatch(/^greet\.so$/m);
    expect(r.read("installed.list")).toMatch(/^greet\.la$/m);
  }, 1_800_000);

  it("CMake builds a MODULE library the program dlopens and refuses SHARED", async () => {
    const r = await build("cmake", [
      "cmake -S . -B build > configure.log 2>&1",
      "cmake --build build > build.log 2>&1",
      "./build/host ./build/libgreet.so > run.out",
      "cp counter.c shared-refused-cmake/",
      "if cmake -S shared-refused-cmake -B build-shared > shared.log 2>&1; then exit 1; fi",
    ], ["configure.log", "build.log", "shared.log"]);
    expect(r.exitCode, r.detail).toBe(0);

    expect(r.read("configure.log")).not.toMatch(/does\s+not\s+support\s+dynamic\s+linking/);
    expect(r.read("run.out")).toBe(pluginOutput);
    expect(r.read("shared.log")).toMatch(
      /ADD_LIBRARY called with SHARED option but the target platform does not\s+support dynamic linking/,
    );
  }, 1_800_000);

  it("Meson builds a shared_module() the program dlopens and refuses linking a shared library", async () => {
    const r = await build("meson", [
      "meson setup build > setup.log 2>&1",
      "ninja -C build > ninja.log 2>&1",
      "./build/host ./build/libgreet.so > run.out",
      "cp counter.c shared-refused-meson/",
      "if meson setup build-shared shared-refused-meson > shared.log 2>&1; then exit 1; fi",
    ], ["setup.log", "ninja.log", "shared.log"]);
    expect(r.exitCode, r.detail).toBe(0);

    expect(r.read("run.out")).toBe(pluginOutput);
    expect(r.read("shared.log")).toMatch(
      /Executable 'use-counter' cannot link against the shared library 'counter': a Kandelo program cannot be linked against a shared library/,
    );
  }, 1_800_000);
});
