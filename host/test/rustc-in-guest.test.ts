import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tryResolveBinaries } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import { createRustCompilerImage, readRustCompilerJob, rustCompilerArgs, rustCompilerEnv } from "./fixtures/rust-compiler";

// This experimental toolchain is outside local-supported.toml. Required
// acceptance fails on missing artifacts rather than silently skipping them.
const paths = tryResolveBinaries([
  "kernel.wasm", "programs/wasm32/rustc/rustc.wasm",
  "programs/wasm32/rustc/rust-std.zip", "programs/wasm32/kandelo-sdk.zip",
]);
const available = paths.every(path => path !== null);
if (!available && process.env.KANDELO_REQUIRE_GUEST_RUSTC === "1") {
  throw new Error("Build rustc, kernel and kandelo-sdk-browser-bundle before Rust compiler acceptance");
}

describe.skipIf(!available)("Rust compiler inside Kandelo", () => {
  it("type-checks, compiles and runs Rust, then reopens its persistent output", async () => {
    const [kernel, compiler, std, sdk] = paths.map(path => readFileSync(path!));
    const { image, assets } = await createRustCompilerImage(compiler!, std!, sdk!);
    const work = mkdtempSync(join(tmpdir(), "kandelo-rustc-"));
    const options = {
      rootfsImage: image, rootfsLazyAssets: assets, maxWorkers: 8,
      experimentalResizablePersistencePath: join(work, "journal"),
    };
    let host: NodeKernelHost | undefined;
    let sequence = 0;
    async function run(path: string, argv: string[]) {
      const id = `rustc-acceptance-${++sequence}`;
      const { exit } = await host!.spawnFromVfs(path, argv, {
        uid: 1000, gid: 1000, cwd: "/home/maker", env: rustCompilerEnv,
        ownedJob: { id, timeoutMs: 300_000 },
      });
      void exit.catch(() => {});
      return readRustCompilerJob(host!, id);
    }
    try {
      host = new NodeKernelHost(options);
      await host.init(Uint8Array.from(kernel!).buffer);
      const version = await run("/usr/bin/rustc", ["rustc", "-Zunstable-options", "--sysroot", "/usr", "-vV"]);
      expect(version.exitCode, version.stderr).toBe(0);
      expect(version.stdout).toContain("rustc 1.97.0-nightly");
      expect(version.stdout).toContain("host: wasm32-unknown-kandelo-std");
      expect(version.stdout).toContain("LLVM version: 22.1.2");
      const checked = await run("/usr/bin/rustc", [...rustCompilerArgs,
        "--emit=metadata", "--crate-type=lib", "-o", "/home/maker/hello.rmeta"]);
      expect(checked.exitCode, checked.stderr).toBe(0);
      expect((await host.readFileFromVfs("/home/maker/hello.rmeta"))?.byteLength).toBeGreaterThan(0);
      const compiled = await run("/usr/bin/rustc", [...rustCompilerArgs,
        "-Copt-level=0", "-Ccodegen-units=1", "-Cdebuginfo=0", "-o", "/home/maker/hello.wasm"]);
      expect(compiled.exitCode, compiled.stderr).toBe(0);
      expect((await host.readFileFromVfs("/home/maker/hello.wasm"))?.subarray(0, 4))
        .toEqual(Uint8Array.of(0, 97, 115, 109));
      expect(await run("/home/maker/hello.wasm", ["hello"]))
        .toMatchObject({ exitCode: 0, stdout: "Kandelo compiled Rust: sum=6\n" });
      const bad = await run("/usr/bin/rustc", [
        ...rustCompilerArgs.slice(0, -1), "/home/maker/type-error.rs", "--emit=metadata",
        "-o", "/home/maker/bad.rmeta",
      ]);
      // Fatal diagnostics currently abort because Rust unwinding is not
      // wired for Kandelo. Keep this boundary visible instead of claiming
      // the compiler's usual exit status 1.
      expect(bad.exitCode).toBe(134);
      expect(bad.stderr).toContain("E0308");
      expect(await host.readFileFromVfs("/home/maker/bad.rmeta")).toBeNull();
      await host.destroy();
      host = undefined;
      host = new NodeKernelHost({ ...options, requireExistingRootfsPersistence: true });
      await host.init(Uint8Array.from(kernel!).buffer);
      expect(await run("/home/maker/hello.wasm", ["hello"]))
        .toMatchObject({ exitCode: 0, stdout: "Kandelo compiled Rust: sum=6\n" });
    } finally {
      await host?.destroy();
      rmSync(work, { recursive: true, force: true });
    }
  }, 900_000);
});
