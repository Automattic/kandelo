import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import {
  createRustSdkUpgradeImage,
  resolveRustSdkUpgradeArtifacts,
} from "./fixtures/rust-sdk-upgrade-image";
import { checkRustSdkUpgrade } from "./fixtures/rust-sdk-upgrade-checks";

const paths = resolveRustSdkUpgradeArtifacts();
const available = paths.every((path) => path !== null);
if (!available && process.env.KANDELO_REQUIRE_RUST_SDK_UPGRADE === "1") {
  throw new Error(
    "SDK upgrade acceptance requires explicit old/new SDKs, kernel and normal unzip package",
  );
}

describe.skipIf(!available)("Persistent Rust SDK upgrades", () => {
  it("invalidates compiler, dependency and build-script caches without touching project or target", async () => {
    const buffers = paths.map((path) => readFileSync(path!));
    const [kernel, next, old, unzip] = buffers;
    const { image, assets, identity, driverSize } =
      await createRustSdkUpgradeImage(old!, next!, unzip!);
    const directory = mkdtempSync(
      join(
        process.env.KANDELO_AGENT_SCRATCH_DIR ?? tmpdir(),
        "rust-sdk-upgrade-",
      ),
    );
    const disk = join(directory, "disk");
    mkdirSync(disk);
    const options = {
      rootfsImage: image,
      rootfsLazyAssets: assets,
      maxWorkers: 8,
      experimentalResizablePersistencePath: join(disk, "journal"),
    };
    writeFileSync(join(directory, "initial.vfs"), image);
    writeFileSync(join(directory, "inputs.json"), JSON.stringify(paths.map((path, i) => ({ path, bytes: buffers[i]!.byteLength, sha256: createHash("sha256").update(buffers[i]!).digest("hex") })), null, 2) + "\n");
    let host = new NodeKernelHost(options);
    let completed = false;
    try {
      await host.init(Uint8Array.from(kernel!).buffer);
      const results = await checkRustSdkUpgrade(
        () => host,
        async () => {
          await host.destroy();
          host = new NodeKernelHost({
            ...options,
            requireExistingRootfsPersistence: true,
          });
          await host.init(Uint8Array.from(kernel!).buffer);
        },
        driverSize,
        identity,
      );
      expect(results.map((result) => result.phase)).toContain("reopened-fresh");
      writeFileSync(
        join(directory, "upgrade-results.json"),
        JSON.stringify(results, null, 2) + "\n",
      );
      completed = true;
    } finally {
      await host.destroy();
      if (completed) rmSync(disk, { recursive: true, force: true });
      if (!process.env.KANDELO_AGENT_SCRATCH_DIR)
        rmSync(directory, { recursive: true, force: true });
    }
  }, 2_400_000);
});
