import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { tryResolveBinary } from "../src/binary-resolver";
import { runGuestBuild } from "../src/node-guest-build";

// The build image's patch (GNU patch) and binary tools (LLVM's ar, nm,
// objdump, llvm-readobj, size, c++filt, strings, strip) do their work inside
// Kandelo. The posix-utils-lite placeholders they replaced reported success
// without it: patch changed nothing, nm printed every identifier-like string
// as a symbol, and strip removed the ABI section a program needs to load.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures/guest-build/binutils");
const kernelPath = tryResolveBinary("kernel.wasm");
const imagePath = tryResolveBinary("programs/kandelo-build-image.vfs.zst");
const available = kernelPath !== null && imagePath !== null;

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!available)("patch and the binary tools inside Kandelo (Node host, build image)", () => {
  it("apply diffs and read, archive and strip programs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-binutils-"));
    workspaces.push(dir);
    cpSync(fixture, dir, { recursive: true });
    let log = "";
    const { exitCode } = await runGuestBuild({
      kernelWasm: new Uint8Array(readFileSync(kernelPath!)),
      image: new Uint8Array(readFileSync(imagePath!)),
      request: {
        workspace: dir,
        argv: ["/bin/sh", "./check.sh"],
        sourceDateEpoch: 1704067200,
        timeoutMs: 600_000,
      },
      log: (chunk) => { log += new TextDecoder().decode(chunk); },
    });
    expect(exitCode, log).toBe(0);
    const out = (name: string) => readFileSync(join(dir, name), "utf8");

    expect(out("greet.c")).toContain("int greeting_count(void) { return 2; }");
    expect(out("patch.out")).toContain("patching file greet.c");
    expect(out("stale.out")).toMatch(/1 out of 1 hunk FAILED|hunks? failed/i);

    expect(out("ar.out")).toBe("greet.o\n");
    expect(out("nm.out")).toMatch(/^[0-9a-f]+ T main$/m);
    expect(out("nm.out")).toMatch(/^[0-9a-f]+ T greeting_count$/m);
    expect(out("nm.out")).toMatch(/^\s+U puts$/m);
    expect(out("objdump.out")).toMatch(/file format wasm/);
    expect(out("objdump.out")).toMatch(/\bCODE\b/);
    expect(out("readobj.out")).toMatch(/Type: CODE/);
    expect(out("size.out")).toMatch(/greet\.wasm/);
    expect(out("cxxfilt.out")).toBe("kandelo::greet()\n");
    expect(out("strings.out")).toContain("hello");

    expect(out("run.out")).toBe("hello\nhello\n");
  }, 900_000);
});
