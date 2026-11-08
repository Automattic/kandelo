import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { createRustCargoImage, resolveRustCargoArtifacts } from "./fixtures/rust-cargo";
import { rustCompilerEnv } from "./fixtures/rust-compiler";
import { exerciseRustDevtools, rustDevtoolFiles } from "./fixtures/rust-devtools";

const paths = resolveRustCargoArtifacts();
const available = paths.every(path => path !== null);
if (!available && process.env.KANDELO_REQUIRE_GUEST_CARGO === "1") {
  throw new Error("Build kernel and kandelo-rust-sdk before Rust developer-tool acceptance");
}

describe.skipIf(!available)("Rust developer tools inside Kandelo", () => {
  it("formats code, enforces Clippy lints, generates documentation and executes a doctest", async () => {
    const [kernel, bundle] = paths.map(path => readFileSync(path!));
    const { image, assets } = await createRustCargoImage(bundle!, rustDevtoolFiles);
    const work = mkdtempSync(join(tmpdir(), "kandelo-rust-devtools-"));
    const host = new NodeKernelHost({
      rootfsImage: image, rootfsLazyAssets: assets, maxWorkers: 8,
      experimentalResizablePersistencePath: join(work, "journal"),
    });
    try {
      await host.init(Uint8Array.from(kernel!).buffer);
      const result = await exerciseRustDevtools(host, rustCompilerEnv);
      expect(result.results["doctests"]!.stdout).toContain("1 passed; 0 failed");
      expect(result.docsHtml).toContain("Adds two numbers");
    } finally {
      await host.destroy();
      rmSync(work, { recursive: true, force: true });
    }
  }, 1_800_000);
});
