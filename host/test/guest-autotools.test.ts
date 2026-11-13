import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { tryResolveBinary } from "../src/binary-resolver";
import { runGuestBuild } from "../src/node-guest-build";

// The GNU build tools work together inside Kandelo: autoreconf (Autoconf,
// Automake, Libtool, autopoint, an Autoconf Archive macro) generates the
// build, the generated configure runs natively (config.guess identifies the
// machine, pkg-config finds a .pc file, gettext's macros enable NLS), and
// make runs Bison, gperf, the compiler, Libtool, msgfmt, makeinfo and
// help2man before the test suite checks the program.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures/guest-build/autotools");
const kernelPath = tryResolveBinary("kernel.wasm");
const imagePath = tryResolveBinary("programs/kandelo-build-image.vfs.zst");
const available = kernelPath !== null && imagePath !== null;

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const script = [
  "set -eu",
  "autoreconf -fi > autoreconf.log 2>&1",
  "PKG_CONFIG_PATH=$PWD ./configure > configure.log 2>&1",
  "make > make.log 2>&1",
  "make check > check.log 2>&1",
  "./calc --version > version.out",
  "printf '1+2*3\\ntwo*three+one\\n' | ./calc > calc.out",
  "msgunfmt po/de.gmo > de.out",
].join("\n");

describe.skipIf(!available)("GNU build tools inside Kandelo (Node host, build image)", () => {
  it("autoreconf, configure, make and make check a project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-autotools-"));
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
    const logs = ["autoreconf.log", "configure.log", "make.log", "check.log"]
      .map((name) => `--- ${name}\n${read(name).slice(-4000)}`).join("\n");
    expect(exitCode, `${log}\n${logs}`).toBe(0);

    // config.guess identified the machine, so this is a native build: the
    // configure tests ran inside Kandelo rather than being assumed.
    const configureLog = read("configure.log");
    expect(configureLog).toMatch(/checking build system type\.\.\. wasm32-unknown-linux-musl/);
    expect(configureLog).toMatch(/checking whether we are cross compiling\.\.\. no/);
    expect(configureLog).toMatch(/checking for greeting >= 1\.0\.\.\. yes/);
    expect(configureLog).toMatch(/checking whether to use NLS\.\.\. yes/);
    // Kandelo executables cannot link against shared libraries, so the
    // shipped libtool reports no dynamic linker and builds static ones, even
    // though LT_INIT leaves shared libraries enabled.
    expect(configureLog).toMatch(/checking dynamic linker characteristics\.\.\. no/);
    expect(configureLog).toMatch(/checking whether to build shared libraries\.\.\. no/);

    expect(read("version.out")).toBe("calc (kandelo-calc) 1.0\nhello from pkg-config\n");
    expect(read("calc.out")).toBe("7\n7\n");
    expect(read("check.log")).toMatch(/# PASS: +1/);
    expect(read("calc.1")).toMatch(/^\.TH CALC "1"/m);
    expect(read("calc.info")).toContain("evaluates one sum or product per line");
    // msgfmt compiled the German catalog that autopoint's po/ rules build.
    expect(read("de.out")).toMatch(/msgid "Hello"\nmsgstr "Hallo"/);
  }, 1_800_000);
});
