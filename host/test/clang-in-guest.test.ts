import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  createSourceOnlyBinarySnapshotSession,
  tryResolveBinaries,
} from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import { MemoryFileSystem, type LazyDownloadEvent } from "../src/vfs/memory-fs";
import { guestCompileCommand, guestCompilerCases } from "./fixtures/in-guest-compiler";

// The kernel, shell, SDK and utilities have distinct package closures.
// Resolve each complete closure under the normal policy; SourceOnly captures
// bind the complete product set to one published generation.
const utilityNames = ["coreutils", "grep", "sed"];
const artifactNames = [
  "kernel.wasm",
  "programs/wasm32/shell.vfs.zst",
  "programs/wasm32/kandelo-sdk.zip",
  ...utilityNames.map((name) => `programs/wasm32/${name}.wasm`),
];
const sourceOnly = process.env.WASM_POSIX_RESOLUTION_POLICY === "source-only-v1";
const artifacts = sourceOnly
  ? createSourceOnlyBinarySnapshotSession().snapshots(artifactNames, 512 * 1024 * 1024)
    .map((snapshot) => snapshot?.bytes ?? null)
  : tryResolveBinaries(artifactNames).map((path) =>
      path === null ? null : new Uint8Array(readFileSync(path)));
const available = artifacts.length === artifactNames.length && artifacts.every((bytes) => bytes !== null);
if (!available && (sourceOnly || process.env.KANDELO_REQUIRE_GUEST_COMPILER === "1")) {
  throw new Error("Build the current kernel and browser-main-shell product before compiler acceptance");
}

const lazyBase = "https://kandelo.invalid/";
const sdkUrl = `${lazyBase}kandelo-sdk.zip`;

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe.skipIf(!available)("base shell in-guest compiler", () => {
  it("fetches one deferred SDK archive on first use, then compiles and runs C and C++", async () => {
    const [kernel, shell, sdk, ...utilities] = artifacts as Uint8Array[];
    const image = MemoryFileSystem.fromImage(shell!);
    for (const path of [
      "/usr/bin/cc", "/usr/bin/c++", "/usr/lib/llvm/bin/clang",
      "/usr/lib/llvm/bin/wasm-ld", "/usr/lib/llvm/bin/llvm-ar",
      "/usr/lib/llvm/bin/llvm-ranlib", "/usr/lib/llvm/bin/llvm-nm",
      "/usr/wasm32posix/sysroot/lib/libc.a",
      "/usr/wasm32posix/sysroot/include/c++/v1/vector",
    ]) {
      expect(image.isPathDeferred(path), `${path} must be a lazy reference in shell.vfs.zst`).toBe(true);
    }

    let stdout = "";
    let stderr = "";
    const downloads: LazyDownloadEvent[] = [];
    const host = new NodeKernelHost({
      rootfsImage: shell!,
      rootfsLazyUrlBase: lazyBase,
      rootfsLazyAssets: [{
        url: sdkUrl,
        sha256: createHash("sha256").update(sdk!).digest("hex"),
        size: sdk!.byteLength,
        bytes: sdk!,
      }, ...utilities.map((bytes, index) => ({
        url: `${lazyBase}binaries/programs/wasm32/${utilityNames[index]}.wasm`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
        bytes,
      }))],
      onStdout: (_pid, bytes) => { stdout += new TextDecoder().decode(bytes); },
      onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
      onLazyDownload: (event) => { downloads.push(event); },
    });
    const sdkDownloads = () => downloads.filter((event) => event.url === sdkUrl);
    async function run(command: string) {
      stdout = "";
      stderr = "";
      const { exit } = await host.spawnFromVfs("/usr/bin/bash", ["bash", "-lc", command], {
        env: ["PATH=/usr/bin:/bin", "HOME=/home/maker", "USER=maker", "TMPDIR=/tmp"],
        cwd: "/tmp",
        uid: 1000,
        gid: 1000,
        stdin: new Uint8Array(),
      });
      const exitCode = await exit;
      return { exitCode, stdout, stderr };
    }

    try {
      await host.init(arrayBuffer(kernel!));
      expect(await run("printf 'shell startup OK\\n'")).toMatchObject({
        exitCode: 0, stdout: "shell startup OK\n",
      });
      expect(sdkDownloads()).toEqual([]);

      for (const sample of guestCompilerCases) {
        const compiled = await run(`set -eu\n${guestCompileCommand(sample)}`);
        expect(compiled.exitCode, `${sample.name}: ${compiled.stderr}\n${compiled.stdout}`).toBe(0);
        const wasm = await host.readFileFromVfs(`/tmp/${sample.name}`);
        expect(wasm?.subarray(0, 4)).toEqual(new Uint8Array([0, 97, 115, 109]));
        const executed = await run(`/tmp/${sample.name}${sample.args}`);
        expect(executed.exitCode, `${sample.name}: ${executed.stderr}\n${executed.stdout}`).toBe(sample.exitCode);
        expect(executed.stdout).toContain(sample.output);
        expect(sdkDownloads().filter((event) => event.status === "started")).toHaveLength(1);
        expect(sdkDownloads().filter((event) => event.status === "complete")).toHaveLength(1);
        expect(sdkDownloads().filter((event) => event.status === "error")).toEqual([]);
      }
    } finally {
      await host.destroy();
    }
  }, 600_000);
});
