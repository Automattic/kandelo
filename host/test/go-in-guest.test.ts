import { expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import {
  goGuestAbiDigest, goGuestArtifacts, goGuestLazyBase, goGuestOutput, goGuestOutputPath,
  goGuestShellCommand, goGuestShellOptions,
} from "./fixtures/go-in-guest";

it("builds and runs a local Go module offline from the Kandelo shell", async () => {
  const { kernel, shell, archive } = goGuestArtifacts();
  let stdout = "";
  let stderr = "";
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  const host = new NodeKernelHost({
    rootfsImage: shell,
    rootfsLazyUrlBase: goGuestLazyBase,
    rootfsLazyAssetDirectory: goGuestLazyBase,
    rootfsLazyAssets: [archive],
    enableTcpNetwork: false,
    onStdout: (_pid, bytes) => { stdout += stdoutDecoder.decode(bytes, { stream: true }); },
    onStderr: (_pid, bytes) => { stderr += stderrDecoder.decode(bytes, { stream: true }); },
  });
  try {
    await host.init(kernel.slice().buffer as ArrayBuffer);
    const process = await host.spawnFromVfs("/bin/bash", ["bash", "-ec", goGuestShellCommand()], goGuestShellOptions);
    expect(await process.exit, stderr).toBe(0);
    expect(stdout).toBe(goGuestOutput);
    for (const tool of ["compile", "asm", "link"]) {
      expect(stderr).toContain(`/usr/lib/go/pkg/tool/kandelo_wasm32/${tool} `);
    }
    const output = await host.readFileFromVfs(goGuestOutputPath);
    expect(output).toBeDefined();
    const digest = goGuestAbiDigest(kernel);
    expect(digest).not.toBeNull();
    expect(goGuestAbiDigest(output!)).toEqual(digest);
  } finally {
    await host.destroy();
  }
}, 1_200_000);
