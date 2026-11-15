import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { tryResolveBinary } from "../src/binary-resolver";
import { runGuestBuild } from "../src/node-guest-build";

// Meson and Ninja inside Kandelo: meson setup runs the guest Python, detects
// the guest compiler and probes it natively (header, function and sizeof
// checks), ninja builds a static library and an executable that links it,
// and meson test runs the executable and a test script.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures/guest-build/meson");
const kernelPath = tryResolveBinary("kernel.wasm");
const imagePath = tryResolveBinary("programs/kandelo-build-image.vfs.zst");
const available = kernelPath !== null && imagePath !== null;

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const script = [
  "set -eu",
  "meson --version > meson-version.out",
  "ninja --version > ninja-version.out",
  "meson setup build > setup.log 2>&1",
  "ninja -C build > ninja.log 2>&1",
  "meson test -C build > test.log 2>&1",
  "meson install -C build --destdir $PWD/stage > install.log 2>&1",
  "./build/calc --version > calc-version.out",
].join("\n");

describe.skipIf(!available)("Meson and Ninja inside Kandelo (Node host, build image)", () => {
  it("meson setup, ninja, meson test and meson install a C project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-meson-"));
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
    const logs = ["setup.log", "ninja.log", "test.log", "build/meson-logs/testlog.txt", "install.log"]
      .map((name) => `--- ${name}\n${read(name).slice(-4000)}`).join("\n");
    expect(exitCode, `${log}\n${logs}`).toBe(0);

    expect(read("meson-version.out")).toBe("1.12.1\n");
    expect(read("ninja-version.out")).toBe("1.13.2\n");

    // A native build: Meson describes the machine it runs on from uname and
    // the guest compiler, and runs its sanity-check program there.
    const setup = read("setup.log");
    expect(setup).toMatch(/^Build type: native build$/m);
    expect(setup).toMatch(/^C compiler for the host machine: cc \(clang 21\.1\.7/m);
    expect(setup).toMatch(/^Host machine cpu family: wasm32$/m);
    expect(setup).toMatch(/^Has header "unistd\.h" : YES/m);
    expect(setup).toMatch(/^Checking for function "getopt" : YES/m);
    expect(setup).toMatch(/^Checking for size of "long" : 4 *$/m);

    // The executable has no .js suffix (Meson's Emscripten convention).
    expect(read("calc-version.out")).toBe("calc 1.0 (wasm-posix wasm32, long is 4 bytes)\n");
    expect(read("test.log")).toMatch(/^Ok: +3 *$/m);
    expect(read("test.log")).toMatch(/^Fail: +0 *$/m);
    expect(read("stage/usr/local/bin/calc").length).toBeGreaterThan(0);
  }, 1_800_000);
});
