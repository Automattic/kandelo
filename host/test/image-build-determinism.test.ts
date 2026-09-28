/**
 * Deterministic image-build mode (`imageBuildDeterminism`,
 * `crates/runtime-core/src/image_build_determinism.rs`).
 *
 * The WordPress and LAMP image builders run WordPress's installer inside a
 * kernel booted with this mode, so the bytes the installer writes are a
 * function of the build's inputs. These tests pin the contract at the level a
 * guest sees it, with bash builtins (`$EPOCHREALTIME` reads CLOCK_REALTIME,
 * `$SRANDOM` reads getrandom(2)) so no fork or lazy binary is involved:
 *
 * - two boots with the same seed observe the same clock and the same
 *   "random" bytes, starting at the configured epoch;
 * - a different seed yields different bytes;
 * - a normal boot keeps the host's real clock and entropy.
 */
import { describe, expect, it } from "vitest";
import { tryResolveRootfsArtifact } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import type { ImageBuildDeterminism } from "../src/types";

// The image `rootfsImage: "default"` boots, found the way the host finds it.
const haveRootfs = tryResolveRootfsArtifact() !== null;

const PROBE = [
  'printf "%s\\n" "$EPOCHREALTIME" "$EPOCHREALTIME"',
  'printf "%s\\n" "$SRANDOM" "$SRANDOM" "$SRANDOM"',
].join("; ");

async function probe(determinism?: ImageBuildDeterminism): Promise<string[]> {
  let stdout = "";
  let stderr = "";
  const host = new NodeKernelHost({
    rootfsImage: "default",
    imageBuildDeterminism: determinism,
    onStdout: (_pid, data) => { stdout += new TextDecoder().decode(data); },
    onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
  });
  try {
    await host.init();
    const { exit } = await host.spawnFromVfs("/bin/bash", ["bash", "-c", PROBE], {
      env: ["PATH=/usr/bin:/bin"],
      cwd: "/",
    });
    expect(await exit, stderr).toBe(0);
  } finally {
    await host.destroy();
  }
  return stdout.trim().split("\n");
}

describe.skipIf(!haveRootfs)("deterministic image-build mode", () => {
  it("gives two boots with one seed the same clock and entropy", async () => {
    const config = { seed: 0x7e57_0001, epochSeconds: 315_532_800 };
    const first = await probe(config);
    const second = await probe(config);
    expect(first).toEqual(second);
    expect(first).toHaveLength(5);
    // The wall clock starts at the configured epoch and still moves between
    // reads (software polls for it to change).
    const [t1, t2] = first.map(Number);
    expect(Math.floor(t1)).toBe(315_532_800);
    expect(t2).toBeGreaterThan(t1);
    // Consecutive entropy reads differ from each other.
    expect(new Set(first.slice(2)).size).toBe(3);
  }, 60_000);

  it("draws different bytes from a different seed", async () => {
    const a = await probe({ seed: 0x7e57_000a, epochSeconds: 315_532_800 });
    const b = await probe({ seed: 0x7e57_000b, epochSeconds: 315_532_800 });
    expect(a.slice(0, 2)).toEqual(b.slice(0, 2));
    expect(a.slice(2)).not.toEqual(b.slice(2));
  }, 60_000);

  it("leaves a normal boot on the host's real clock and entropy", async () => {
    const before = Date.now() / 1000;
    const a = await probe();
    const b = await probe();
    const t = Number(a[0]);
    expect(t).toBeGreaterThanOrEqual(Math.floor(before) - 1);
    expect(t).toBeLessThanOrEqual(Date.now() / 1000 + 1);
    expect(a.slice(2)).not.toEqual(b.slice(2));
  }, 60_000);

  it("refuses an invalid seed instead of booting with real entropy", async () => {
    const host = new NodeKernelHost({
      rootfsImage: "default",
      imageBuildDeterminism: { seed: -1, epochSeconds: 315_532_800 },
    });
    try {
      await expect(host.init()).rejects.toThrow(/seed must be a non-negative safe integer/);
    } finally {
      await host.destroy().catch(() => {});
    }
  }, 60_000);
});
