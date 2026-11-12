import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { tryResolveBinary } from "../src/binary-resolver";
import { runGuestBuild } from "../src/node-guest-build";

// bash survives many forks. Built with wasm-opt run before fork
// instrumentation, it corrupted its heap a little on every fork and died
// after about 800 subshells (packages/registry/bash/build-bash.sh); a
// libtool-generated configure script forks more than that.
const kernelPath = tryResolveBinary("kernel.wasm");
const imagePath = tryResolveBinary("programs/kandelo-build-image.vfs.zst");
const available = kernelPath !== null && imagePath !== null;

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!available)("bash forks (Node host, build image)", () => {
  it("runs 1200 subshells", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-bash-forks-"));
    workspaces.push(dir);
    let log = "";
    const { exitCode } = await runGuestBuild({
      kernelWasm: new Uint8Array(readFileSync(kernelPath!)),
      image: new Uint8Array(readFileSync(imagePath!)),
      request: {
        workspace: dir,
        argv: ["/bin/sh", "-c", 'i=0; while [ "$i" -lt 1200 ]; do ( : ); i=$((i+1)); done; echo "subshells=$i"'],
        sourceDateEpoch: 1704067200,
        timeoutMs: 600_000,
      },
      log: (chunk) => { log += new TextDecoder().decode(chunk); },
    });
    expect(exitCode, log).toBe(0);
    expect(log).toContain("subshells=1200\n");
  }, 700_000);
});
