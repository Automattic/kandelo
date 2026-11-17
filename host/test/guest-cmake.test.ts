import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { tryResolveBinary } from "../src/binary-resolver";
import { runGuestBuild } from "../src/node-guest-build";

// CMake configures, builds, tests and packages a C/C++ project inside
// Kandelo: cmake identifies the machine as Kandelo and runs its configure
// checks natively (compile, link and run), finds a pkg-config module,
// generates Makefiles that GNU make runs with the guest compiler, ctest runs
// the tests, and cpack writes a tarball through CMake's libarchive.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures/guest-build/cmake");
const kernelPath = tryResolveBinary("kernel.wasm");
const imagePath = tryResolveBinary("programs/kandelo-build-image.vfs.zst");
const available = kernelPath !== null && imagePath !== null;

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const script = [
  "set -eu",
  "{ cmake --version; ctest --version; cpack --version; } > version.out",
  "PKG_CONFIG_PATH=$PWD cmake -S . -B build > configure.log 2>&1",
  "cmake --build build > build.log 2>&1",
  "ctest --test-dir build --output-on-failure > ctest.log 2>&1",
  "./build/calc --version > calc.out",
  "./build/calc '*' 6 7 >> calc.out",
  "(cd build && cpack > ../cpack.log 2>&1)",
  "tar tzf build/kcalc-1.0-Kandelo.tar.gz > package.list",
].join("\n");

describe.skipIf(!available)("CMake inside Kandelo (Node host, build image)", () => {
  it("configures, builds, tests and packages a project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-cmake-"));
    workspaces.push(dir);
    cpSync(fixture, dir, { recursive: true });
    let log = "";
    const { exitCode } = await runGuestBuild({
      kernelWasm: new Uint8Array(readFileSync(kernelPath!)),
      image: new Uint8Array(readFileSync(imagePath!)),
      request: {
        workspace: dir,
        argv: ["/bin/sh", "-c", script],
        sourceDateEpoch: 1704067200,
        timeoutMs: 1_500_000,
      },
      log: (chunk) => { log += new TextDecoder().decode(chunk); },
    });
    const read = (name: string) => {
      try { return readFileSync(join(dir, name), "utf8"); } catch { return "(missing)"; }
    };
    const logs = ["configure.log", "build.log", "ctest.log", "cpack.log"]
      .map((name) => `--- ${name}\n${read(name).slice(-4000)}`).join("\n");
    expect(exitCode, `${log}\n${logs}`).toBe(0);

    expect(read("version.out")).toMatch(
      /^cmake version 4\.5\.0\n[\s\S]*ctest version 4\.5\.0\n[\s\S]*cpack version 4\.5\.0\n/,
    );

    // CMake named the machine Kandelo and built natively, not as a cross
    // build, so its checks ran inside Kandelo.
    const system = read("build/CMakeFiles/4.5.0/CMakeSystem.cmake");
    expect(system).toContain('set(CMAKE_HOST_SYSTEM_NAME "Kandelo")');
    expect(system).toContain('set(CMAKE_SYSTEM_NAME "Kandelo")');
    expect(system).toContain('set(CMAKE_SYSTEM_PROCESSOR "wasm32")');
    expect(system).toContain('set(CMAKE_CROSSCOMPILING "FALSE")');
    const configureLog = read("configure.log");
    expect(configureLog).not.toContain("System is unknown to cmake");
    expect(configureLog).toMatch(/Performing Test POINTERS_ARE_32_BITS - Success/);
    expect(configureLog).toMatch(/Checking for module 'greeting>=1\.0'\n-- {3}Found greeting, version 1\.2/);
    // Kandelo executables cannot link against shared libraries; the
    // platform module says so, and under the project's policies (before
    // CMP0164) CMake warns and builds the SHARED library static.
    expect(configureLog).toMatch(/does\s+not\s+support\s+dynamic\s+linking\.\s+Building\s+a\s+STATIC\s+library\s+instead/);

    expect(read("ctest.log")).toMatch(/100% tests passed out of 3\n/);
    expect(read("calc.out")).toBe("calc 1.0 (Kandelo, plugin)\nhello from pkg-config\n42\n");
    expect(read("package.list")).toMatch(/kcalc-1\.0-Kandelo\/bin\/calc\n/);
    expect(read("package.list")).toMatch(/kcalc-1\.0-Kandelo\/lib\/libops\.a\n/);
  }, 1_800_000);
});
