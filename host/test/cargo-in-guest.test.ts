import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tryResolveBinaries } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import { cargoProjectOutput } from "./fixtures/cargo-project";
import { createRustCargoImage } from "./fixtures/rust-cargo";
import { readRustCompilerJob, rustCompilerEnv } from "./fixtures/rust-compiler";

const paths = tryResolveBinaries(["kernel.wasm", "programs/wasm32/kandelo-rust-sdk.zip"]);
const available = paths.every(path => path !== null);
if (!available && process.env.KANDELO_REQUIRE_GUEST_CARGO === "1") {
  throw new Error("Build kernel and kandelo-rust-sdk before Cargo acceptance");
}

describe.skipIf(!available)("Cargo inside Kandelo", () => {
  it("checks, builds and runs a workspace with a build script across a persistent reboot", async () => {
    const [kernel, bundle] = paths.map(path => readFileSync(path!));
    const { image, assets } = await createRustCargoImage(bundle!);
    const work = mkdtempSync(join(tmpdir(), "kandelo-cargo-"));
    const options = { rootfsImage: image, rootfsLazyAssets: assets, maxWorkers: 8,
      experimentalResizablePersistencePath: join(work, "journal") };
    let host: NodeKernelHost | undefined;
    let sequence = 0;
    async function run(path: string, argv: string[]) {
      const id = `cargo-acceptance-${++sequence}`;
      console.info("[cargo acceptance]", argv.join(" "));
      const { exit } = await host!.spawnFromVfs(path, argv, {
        uid: 1000, gid: 1000, cwd: "/home/maker/project", env: rustCompilerEnv,
        ownedJob: { id, timeoutMs: 300_000 },
      });
      void exit.catch(() => {});
      const result = await readRustCompilerJob(host!, id);
      console.info("[cargo acceptance]", result);
      expect(result.exitCode, result.stderr).toBe(0);
      return result;
    }
    const cargo = (...args: string[]) => run("/usr/bin/cargo", ["cargo", ...args]);
    try {
      host = new NodeKernelHost(options);
      await host.init(Uint8Array.from(kernel!).buffer);
      expect((await cargo("-vV")).stdout).toContain("cargo 1.97.0-nightly");
      expect((await cargo("metadata", "--offline", "--format-version=1")).stdout).toContain('"name":"message"');
      await cargo("check", "--offline", "-j1");
      expect((await cargo("run", "--offline", "-j1", "-p", "cargo-hello")).stdout).toContain(cargoProjectOutput);
      expect((await host.readFileFromVfs("/home/maker/project/target/debug/cargo-hello.wasm"))?.byteLength).toBeGreaterThan(0);
      expect((await cargo("build", "--offline", "-j1")).stderr).not.toContain("Compiling");
      await host.destroy(); host = undefined;
      host = new NodeKernelHost({ ...options, requireExistingRootfsPersistence: true });
      await host.init(Uint8Array.from(kernel!).buffer);
      expect((await cargo("run", "--offline", "-j1", "-p", "cargo-hello")).stdout).toBe(cargoProjectOutput);
      expect((await run("/home/maker/project/target/debug/cargo-hello.wasm", ["cargo-hello"])).stdout).toBe(cargoProjectOutput);
    } finally {
      await host?.destroy();
      rmSync(work, { recursive: true, force: true });
    }
  }, 1_200_000);
});
