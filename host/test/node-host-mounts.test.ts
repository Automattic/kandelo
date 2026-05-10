/**
 * Task 4.3 — Node host wires `host/wasm/rootfs.vfs` and applies
 * `DEFAULT_MOUNT_SPEC` via `resolveForNode` at boot when the caller
 * does not supply a custom `io`.
 *
 * Each probe runs `examples/mount_probe_test.wasm` with a mode argv:
 *
 *   rootfs    /etc/services exists in the rootfs image and matches
 *             the on-disk source under `rootfs/etc/services`.
 *
 *   scratch   /tmp/<file> is writable through the mount router and
 *             persists across open/close within the same process.
 *
 *   unmounted /no/such/mount returns ENOENT (proves the mount router
 *             enforces VFS-only-lens — no fallthrough to the host fs).
 *
 *   custom    overriding `io` opts out of the default mount setup —
 *             /etc/services is no longer reachable via the rootfs image.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { NodePlatformIO } from "../src/platform/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");
const probeWasm = join(repoRoot, "examples/mount_probe_test.wasm");
const rootfsImage = join(repoRoot, "host/wasm/rootfs.vfs");
const servicesSource = join(repoRoot, "rootfs/etc/services");

const haveProbe = existsSync(probeWasm);
const haveRootfs = existsSync(rootfsImage);

describe.skipIf(!haveProbe || !haveRootfs)("node-host default mount setup", () => {
  it("stat + read /etc/services from the mounted rootfs image", async () => {
    const expected = readFileSync(servicesSource);
    const expectedHead = Array.from(expected.subarray(0, 16))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const result = await runCentralizedProgram({
      programPath: probeWasm,
      argv: ["mount_probe_test", "rootfs", "/etc/services"],
      timeout: 10_000,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`ROOTFS size=${expected.length}`);
    expect(result.stdout).toContain(`head=${expectedHead}`);
  });

  it("/tmp scratch mount round-trips a write through the host filesystem", async () => {
    const result = await runCentralizedProgram({
      programPath: probeWasm,
      argv: ["mount_probe_test", "scratch", "/tmp/mount-probe.txt"],
      timeout: 10_000,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("SCRATCH size=24");
    expect(result.stdout).toContain("content=scratch-mount-roundtrip");
  });

  it("returns ENOENT for paths outside every mount (no fallthrough)", async () => {
    const result = await runCentralizedProgram({
      programPath: probeWasm,
      argv: ["mount_probe_test", "unmounted", "/no/such/mount/point"],
      timeout: 10_000,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    // ENOENT is 2 on the wasm32 musl ABI used by user programs.
    expect(result.stdout).toContain("UNMOUNTED errno=2");
  });

  it("custom `io` override bypasses the default mount setup", async () => {
    // NodePlatformIO has no synthetic /etc/services entry and the host
    // filesystem doesn't have one at the root either, so it must fail.
    const result = await runCentralizedProgram({
      programPath: probeWasm,
      argv: ["mount_probe_test", "rootfs", "/etc/services"],
      io: new NodePlatformIO(),
      timeout: 10_000,
    });

    // The probe prints ROOTFS stat-errno=<n> when stat fails. We just
    // assert the success line is absent — the precise errno depends on
    // the host's /etc/services (macOS has one, Linux too), so we can't
    // hard-code a value. The point is: with a custom `io`, the call no
    // longer goes through the rootfs.vfs image we built for these tests
    // (size differs from the host's /etc/services).
    if (result.exitCode === 0) {
      const expected = readFileSync(servicesSource);
      // If somehow it succeeded, it must NOT match the rootfs image
      // (which is what the default-mount path would have returned).
      expect(result.stdout).not.toContain(`ROOTFS size=${expected.length}`);
    }
  });
});
