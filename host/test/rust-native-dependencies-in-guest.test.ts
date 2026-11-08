import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { createRustCargoImage, resolveRustCargoArtifacts } from "./fixtures/rust-cargo";
import { rustCompilerEnv } from "./fixtures/rust-compiler";
import { rustNativeDependencyFiles } from "./fixtures/rust-native-dependency-source";
import { exerciseRustNativeDependencies } from "./fixtures/rust-native-dependencies";

const paths = resolveRustCargoArtifacts();
const fixturePath = process.env.KANDELO_GUEST_RUST_NATIVE_FIXTURES;
const available = paths.every(path => path !== null) && fixturePath !== undefined;
if (!available && process.env.KANDELO_REQUIRE_GUEST_CARGO === "1") {
  throw new Error("Build kernel, kandelo-rust-sdk and rust-native-fixtures; set KANDELO_GUEST_RUST_NATIVE_FIXTURES to its ZIP");
}

describe.skipIf(!available)("Rust native build dependencies inside Kandelo", () => {
  it("compiles the real cc crate and executes its C/C++ output", async () => {
    const [kernel, bundle] = paths.map(path => readFileSync(path!));
    const { image, assets } = await createRustCargoImage(bundle!, rustNativeDependencyFiles(readFileSync(fixturePath!)));
    const work = mkdtempSync(join(tmpdir(), "kandelo-rust-native-dependencies-"));
    const host = new NodeKernelHost({
      rootfsImage: image, rootfsLazyAssets: assets, maxWorkers: 8,
      experimentalResizablePersistencePath: join(work, "journal"),
    });
    try {
      await host.init(Uint8Array.from(kernel!).buffer);
      const results = await exerciseRustNativeDependencies(host, rustCompilerEnv);
      expect(results.configured?.stdout).toBe("cc-rs native execution=42/7\n");
    } finally {
      await host.destroy();
      rmSync(work, { recursive: true, force: true });
    }
  }, 1_800_000);
});
