/**
 * End-to-end smoke for the mount-table VFS. The C program
 * (examples/vfs_smoke.c) exercises one representative operation per
 * backend type so a regression in routing, the shadow-metadata store,
 * virtual-dir synthesis, or the cross-mount EXDEV check fails loudly
 * here before it shows up as a confusing breakage in a port.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const binary = join(__dirname, "../../examples/vfs_smoke.wasm");

describe.skipIf(!existsSync(binary))("vfs_smoke (mount-table end-to-end)", () => {
  it("exercises image, scratch, shadow store, virtual dirs, ENOENT, EXDEV, mkdir", async () => {
    const r = await runCentralizedProgram({
      programPath: binary,
      argv: ["vfs_smoke"],
      timeout: 15_000,
    });

    if (r.exitCode !== 0) {
      throw new Error(
        `vfs_smoke exited ${r.exitCode}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
      );
    }

    // Image-backed read + content sanity (rootfs.vfs → MemFsBackend).
    expect(r.stdout).toContain("OK etc-passwd\n");
    // Image-backed stat reports honest uid/gid from the manifest (not the
    // process euid). Guards the Task 0.4 fix.
    expect(r.stdout).toContain("OK etc-passwd-uid-gid-honest\n");
    // Host-dir scratch: write + read-back through HostDirBackend.
    expect(r.stdout).toContain("OK tmp-write-readback\n");
    // Shadow metadata store: chown round-trips without leaking the host uid.
    expect(r.stdout).toContain("OK tmp-chown-roundtrip\n");
    // Virtual intermediate dir synthesis: "/" exists and stats as a dir even
    // though no backend owns it directly.
    expect(r.stdout).toContain("OK root-virtual-dir\n");
    // Unmounted path: ENOENT, no implicit fall-through to the host FS.
    expect(r.stdout).toContain("OK unmounted-enoent\n");
    // Cross-backend rename returns EXDEV (image /etc ↔ host-dir /tmp).
    expect(r.stdout).toContain("OK cross-backend-exdev\n");
    // mkdir into a scratch mount.
    expect(r.stdout).toContain("OK home-mkdir\n");

    expect(r.stdout).toContain("DONE\n");
    expect(r.stdout).not.toContain("FAIL ");
  });
});
