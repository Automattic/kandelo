import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { createDirectoryMutationFixture, directoryMutationKernel } from "./fixtures/directory-mutation-build";
import { readRustCompilerJob as readGuestJob } from "./fixtures/rust-guest-job";

describe.skipIf(!directoryMutationKernel)("Directory cookies during mutation", () => {
  it("moves and deletes every entry and seeks after unlink on persistent rootfs and tmpfs", async () => {
    const fixture = await createDirectoryMutationFixture();
    const directory = mkdtempSync(join(tmpdir(), "kandelo-directory-mutation-"));
    const host = new NodeKernelHost({ rootfsImage: fixture.image,
      experimentalResizablePersistencePath: join(directory, "journal") });
    try {
      await host.init(Uint8Array.from(readFileSync(directoryMutationKernel!)).buffer);
      const command = await host.spawnFromVfs("/usr/bin/directory-mutation", ["directory-mutation"], {
        uid: 1000, gid: 1000, ownedJob: { id: "directory-mutation", timeoutMs: 300_000 },
      });
      void command.exit.catch(() => {});
      const result = await readGuestJob(host, "directory-mutation", 330_000);
      expect(result.exitCode, JSON.stringify(result)).toBe(0);
      expect(result.stdout).toContain("directory-cookies: rootfs=256 tmpfs=256 seekdir=ok");
      expect(result.stderr).toBe("");
    } finally {
      await host.destroy(); fixture.cleanup(); rmSync(directory, { recursive: true, force: true });
    }
  }, 600_000);
});
