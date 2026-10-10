import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHELL_LAZY_BINARY_SPECS } from "../../images/vfs/lib/init/shell-binaries";
import { tryResolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import { ensureDirRecursive, writeVfsBinary } from "../src/vfs/image-helpers";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import type { LazyDownloadEvent } from "../src/vfs/lazy-download-event";
import { runCentralizedProgram } from "./centralized-test-helper";

const jqBinary = tryResolveBinary("programs/jq.wasm");
const bashBinary = tryResolveBinary("programs/bash.wasm");

describe.skipIf(!jqBinary)("jq CLI on Kandelo", () => {
  it.each([
    {
      name: "release version",
      args: ["--version"],
      stdin: "",
      stdout: "jq-1.8.2\n",
      code: 0,
    },
    {
      name: "JSON selection and aggregation on stdin",
      args: ["-c", "[.items[] | select(.active) | .value] | add"],
      stdin: '{"items":[{"active":true,"value":2},{"active":false,"value":99},{"active":true,"value":3}]}\n',
      stdout: "5\n",
      code: 0,
    },
    {
      name: "bundled Oniguruma capture and Unicode matching",
      args: ["-nrc", '"café-42" | capture("(?<word>\\\\p{L}+)-(?<number>[0-9]+)")'],
      stdin: "",
      stdout: '{"word":"café","number":"42"}\n',
      code: 0,
    },
    {
      name: "decimal literals retain precision",
      args: ["-c", "."],
      stdin: "123456789012345678901234567890\n",
      stdout: "123456789012345678901234567890\n",
      code: 0,
    },
    {
      name: "exit status for false",
      args: ["-ne", "false"],
      stdin: "",
      stdout: "false\n",
      code: 1,
    },
  ])("$name", async ({ args, stdin, stdout, code }) => {
    const result = await runCentralizedProgram({
      programPath: jqBinary!,
      argv: ["jq", ...args],
      stdin,
      useDefaultRootfs: false,
      timeout: 30_000,
    });
    expect(result.exitCode, result.stderr).toBe(code);
    expect(result.stdout).toBe(stdout);
    expect(result.stderr).toBe("");
  });

  it("reports malformed JSON as failure", async () => {
    const result = await runCentralizedProgram({
      programPath: jqBinary!,
      argv: ["jq", "."],
      stdin: '{"broken":\n',
      useDefaultRootfs: false,
    });
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("parse error");
  });
});

describe.skipIf(!jqBinary || !bashBinary)("jq lazy shell execution", () => {
  it("materializes jq through PATH and its /bin alias for a Bash pipeline", async () => {
    const fs = KandeloImageFs.create();
    fs.setImageCapacity(16 * 1024 * 1024);
    ensureDirRecursive(fs, "/usr/bin");
    ensureDirRecursive(fs, "/bin");
    writeVfsBinary(fs, "/usr/bin/bash", new Uint8Array(readFileSync(bashBinary!)));
    const spec = SHELL_LAZY_BINARY_SPECS.find(({ id }) => id === "jq")!;
    const bytes = new Uint8Array(readFileSync(jqBinary!));
    const url = "https://kandelo.invalid/jq.wasm";
    fs.registerLazyFile(spec.vfsPath, url, bytes.byteLength, 0o755);
    for (const alias of spec.symlinks) fs.symlink(spec.vfsPath, alias);
    expect(fs.getLazyEntry("/usr/bin/jq")).not.toBeNull();
    let stdout = "";
    let stderr = "";
    const host = new NodeKernelHost({
      rootfsImage: await fs.saveImage(),
      rootfsLazyAssets: [{
        url,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
        bytes,
      }],
      onStdout: (_pid, data) => { stdout += new TextDecoder().decode(data); },
      onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
    });
    const downloads: LazyDownloadEvent[] = [];
    host.subscribeLazyDownloads((event) => downloads.push(event));
    try {
      const kernelBytes = readFileSync(tryResolveBinary("kernel.wasm")!);
      await host.init(new Uint8Array(kernelBytes).buffer);
      expect(downloads).toEqual([]);
      const { exit } = await host.spawnFromVfs("/usr/bin/bash", [
        "bash", "-c",
        `printf '%s\\n' '{"answer":42}' | jq -e '.answer' && /bin/jq --version`,
      ], { env: ["PATH=/usr/bin:/bin"] });
      expect(await exit, stderr).toBe(0);
      expect(stdout).toBe("42\njq-1.8.2\n");
      expect(stderr).toBe("");
      expect(downloads.filter(({ status }) => status === "complete")).toHaveLength(1);
      expect(downloads.every((event) => event.url === url)).toBe(true);
    } finally {
      await host.destroy();
    }
  }, 60_000);
});
