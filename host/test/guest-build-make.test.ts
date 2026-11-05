import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { tryResolveBinary } from "../src/binary-resolver";
import { runGuestBuild } from "../src/node-guest-build";

// A native build inside Kandelo, with the shape of NetHack's: make builds a
// helper, runs it to generate a header, then compiles and links the program
// against it, with two jobs. The helper reports sizeof(long), which is 4 on
// the wasm32 target and 8 on every machine that cross-compiles Kandelo
// packages, so the generated header proves where the helper ran.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures/guest-build/gen-header");
const kernelPath = tryResolveBinary("kernel.wasm");
const imagePath = tryResolveBinary("programs/kandelo-build-image.vfs.zst");
const available = kernelPath !== null && imagePath !== null;

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function buildFixture(): Promise<{ dir: string; exitCode: number; log: string }> {
  const dir = mkdtempSync(join(tmpdir(), "kandelo-guest-make-"));
  workspaces.push(dir);
  cpSync(fixture, dir, { recursive: true });
  let log = "";
  const { exitCode } = await runGuestBuild({
    kernelWasm: new Uint8Array(readFileSync(kernelPath!)),
    image: new Uint8Array(readFileSync(imagePath!)),
    request: {
      workspace: dir,
      // The program runs in the same machine session it was linked in: the
      // execute bit wasm-ld sets lives in the guest's view of the mount, and
      // the host stores guest-created files as 0600.
      argv: ["/bin/sh", "-c", "make -j2 CC=cc && ./hello.wasm > run.txt"],
      sourceDateEpoch: 1704067200,
      timeoutMs: 600_000,
    },
    log: (chunk) => { log += new TextDecoder().decode(chunk); },
  });
  return { dir, exitCode, log };
}

describe.skipIf(!available)("make inside Kandelo (Node host, build image)", () => {
  it("builds and runs a generator, then compiles and links against its output", async () => {
    const { dir, exitCode, log } = await buildFixture();
    expect(exitCode, log).toBe(0);
    const generated = readFileSync(join(dir, "generated.h"), "utf8");
    expect(generated).toContain("#define GEN_SIZEOF_LONG 4");
    expect(generated).toContain("#define GEN_SIZEOF_POINTER 4");
    expect(readFileSync(join(dir, "run.txt"), "utf8"))
      .toBe("sizeof(long) at build: 4, pointer: 4, sum: 5\n");
  }, 900_000);

  it("produces the same program from two workspaces", async () => {
    const first = await buildFixture();
    const second = await buildFixture();
    expect(first.exitCode, first.log).toBe(0);
    expect(second.exitCode, second.log).toBe(0);
    expect(existsSync(join(first.dir, "hello.wasm"))).toBe(true);
    expect(readFileSync(join(second.dir, "hello.wasm")))
      .toEqual(readFileSync(join(first.dir, "hello.wasm")));
  }, 1_800_000);
});
