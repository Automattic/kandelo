import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { tryResolveBinary } from "../src/binary-resolver";
import { runGuestBuild } from "../src/node-guest-build";
import { writeVfsBinary } from "../src/vfs/image-helpers";

// Boots a real kernel over a minimal image whose /bin/sh is bash, mounts a
// host workspace at /build, and checks the runner's contract: exit status,
// files written through the mount, ordered output, and the timeout.
const kernelPath = tryResolveBinary("kernel.wasm");
const bashPath = tryResolveBinary("programs/bash.wasm");
const available = kernelPath !== null && bashPath !== null;

function minimalImage(): Uint8Array {
  const fs = KandeloImageFs.create();
  for (const dir of ["/bin", "/etc", "/usr", "/usr/bin"]) fs.mkdir(dir, 0o755);
  writeVfsBinary(fs, "/bin/sh", new Uint8Array(readFileSync(bashPath!)), 0o755);
  return fs.exportImage();
}

const workspaces: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "kandelo-guest-build-"));
  workspaces.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function request(dir: string, script: string, timeoutMs = 60_000) {
  return {
    workspace: dir,
    argv: ["/bin/sh", "-c", script],
    sourceDateEpoch: 1704067200,
    timeoutMs,
  };
}

describe.skipIf(!available)("runGuestBuild (Node host, real kernel)", () => {
  it("returns the guest exit status and writes through the workspace mount", async () => {
    const dir = workspace();
    let log = "";
    const result = await runGuestBuild({
      kernelWasm: new Uint8Array(readFileSync(kernelPath!)),
      image: minimalImage(),
      request: request(
        dir,
        'echo "epoch=$SOURCE_DATE_EPOCH home=$HOME" > /build/out.txt; echo first; echo second >&2; exit 3',
      ),
      log: (chunk) => { log += new TextDecoder().decode(chunk); },
    });
    expect(result).toEqual({ exitCode: 3, timedOut: false });
    expect(readFileSync(join(dir, "out.txt"), "utf8"))
      .toBe("epoch=1704067200 home=/build/.home\n");
    expect(log).toContain("first\n");
    expect(log).toContain("second\n");
  }, 60_000);

  it("stops a command that outlives its timeout", async () => {
    const started = Date.now();
    const result = await runGuestBuild({
      kernelWasm: new Uint8Array(readFileSync(kernelPath!)),
      image: minimalImage(),
      request: request(workspace(), "while :; do :; done", 2_000),
      log: () => {},
    });
    expect(result).toEqual({ exitCode: 124, timedOut: true });
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 60_000);
});
