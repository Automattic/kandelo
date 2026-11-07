import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { cargoProjectOutput, cargoTestArgs, cargoFailingTestArgs, cargoWrongPanicArgs } from "./fixtures/cargo-project";
import { createRustCargoImage, resolveRustCargoArtifacts } from "./fixtures/rust-cargo";
import { readRustCompilerJob, rustCompilerEnv } from "./fixtures/rust-compiler";

// Test the optional bundle from its resolver output without publishing it
// into the supported image projection.
const paths = resolveRustCargoArtifacts();
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
    async function run(path: string, argv: string[], expectedExit = 0, timeoutMs = 300_000) {
      const id = `cargo-acceptance-${++sequence}`;
      console.info("[cargo acceptance]", argv.join(" "));
      const { exit } = await host!.spawnFromVfs(path, argv, {
        uid: 1000, gid: 1000, cwd: "/home/maker/project", env: rustCompilerEnv,
        ownedJob: { id, timeoutMs },
      });
      void exit.catch(() => {});
      const result = await readRustCompilerJob(host!, id, timeoutMs + 30_000);
      console.info("[cargo acceptance]", result);
      expect(result.exitCode, result.stdout + result.stderr).toBe(expectedExit);
      return result;
    }
    const cargo = (...args: string[]) => run("/usr/bin/cargo", ["cargo", ...args]);
    try {
      host = new NodeKernelHost(options);
      await host.init(Uint8Array.from(kernel!).buffer);
      expect((await cargo("-vV")).stdout).toContain("cargo 1.97.0-nightly");
      expect((await cargo("metadata", "--offline", "--format-version=1")).stdout).toContain('"name":"message"');
      await cargo("check", "--offline");
      expect((await cargo("run", "--offline", "-j1", "-p", "cargo-hello")).stdout).toContain(cargoProjectOutput);
      expect((await host.readFileFromVfs("/home/maker/project/target/debug/cargo-hello.wasm"))?.byteLength).toBeGreaterThan(0);
      expect((await cargo("build", "--offline", "-j1")).stderr).not.toContain("Compiling");
      // This cold command links and prepares three separate libtest binaries.
      const tests = await run("/usr/bin/cargo", ["cargo", ...cargoTestArgs], 0, 600_000);
      expect(tests.stdout).toContain("test result: ok. 4 passed; 0 failed; 2 ignored");
      expect(tests.stdout).toContain("compiled_binary_runs_as_a_child ... ok");
      expect(tests.stdout).toMatch(/expected_panic.*ok/);
      expect((await run("/usr/bin/cargo", ["cargo", ...cargoFailingTestArgs], 101)).stdout)
        .toContain("test result: FAILED. 0 passed; 1 failed");
      expect((await run("/usr/bin/cargo", ["cargo", ...cargoWrongPanicArgs], 101)).stdout)
        .toContain("panic did not contain expected string");
      await host.destroy(); host = undefined;
      host = new NodeKernelHost({ ...options, requireExistingRootfsPersistence: true });
      await host.init(Uint8Array.from(kernel!).buffer);
      expect((await cargo("run", "--offline", "-j1", "-p", "cargo-hello")).stdout).toBe(cargoProjectOutput);
      expect((await run("/home/maker/project/target/debug/cargo-hello.wasm", ["cargo-hello"])).stdout).toBe(cargoProjectOutput);
      expect((await cargo(...cargoTestArgs)).stdout).toContain("test result: ok. 4 passed; 0 failed; 2 ignored");
    } finally {
      await host?.destroy();
      rmSync(work, { recursive: true, force: true });
    }
  }, 1_200_000);
});
