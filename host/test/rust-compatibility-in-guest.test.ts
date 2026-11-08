import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { createRustCargoImage, resolveRustCargoArtifacts } from "./fixtures/rust-cargo";
import { rustCompilerEnv } from "./fixtures/rust-compiler";
import { rustCompatibilityFiles } from "./fixtures/rust-compatibility-project";
import { exerciseRustNativeCompatibility } from "./fixtures/rust-compatibility";

const paths = resolveRustCargoArtifacts();
const available = paths.every(path => path !== null);
if (!available && process.env.KANDELO_REQUIRE_GUEST_CARGO === "1") {
  throw new Error("Build kernel and kandelo-rust-sdk before Rust compatibility acceptance");
}

describe.skipIf(!available)("Rust native compatibility inside Kandelo", () => {
  it("executes C/C++ build-script output, subprocesses and threaded synchronization", async () => {
    const [kernel, bundle] = paths.map(path => readFileSync(path!));
    const { image, assets } = await createRustCargoImage(bundle!, rustCompatibilityFiles);
    const work = mkdtempSync(join(tmpdir(), "kandelo-rust-compatibility-"));
    const host = new NodeKernelHost({
      rootfsImage: image, rootfsLazyAssets: assets, maxWorkers: 8,
      experimentalResizablePersistencePath: join(work, "journal"),
    });
    try {
      await host.init(Uint8Array.from(kernel!).buffer);
      const results = await exerciseRustNativeCompatibility(host, rustCompilerEnv);
      expect(results["native-process-and-thread-tests"]!.stdout).toContain("synchronization ... ok");
    } finally {
      await host.destroy();
      rmSync(work, { recursive: true, force: true });
    }
  }, 1_800_000);
});
