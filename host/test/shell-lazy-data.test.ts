import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import type { LazyDownloadEvent } from "../src/vfs/lazy-download-event";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const imagePath = join(repoRoot, "local-binaries/source-only-v1/programs/wasm32/shell.vfs.zst");
const optionalData = ["espeak-ng-data.zip", "file-magic.lite", "kandelo-desktop-data.zip"];
const command = [
  "set -eu",
  "espeak-ng --stdout hello > /tmp/lazy-speech.wav",
  'IFS= read -r -N 4 signature < /tmp/lazy-speech.wav',
  'test "$signature" = RIFF',
  "printf 'speech-data-ok\\n'",
  "file -b /etc/passwd",
  "while IFS= read -r line; do printf '%s\\n' \"$line\"; done < /usr/share/kandelo/themes/tokyo-night/theme.conf",
].join("; ");

describe("shell optional data on Node", () => {
  beforeAll(() => {
    vi.stubEnv("WASM_POSIX_RESOLUTION_POLICY", "source-only-v1");
    vi.stubEnv("WASM_POSIX_SOURCE_ONLY_BINARY_ROOT", join(repoRoot, "local-binaries/source-only-v1"));
    vi.stubEnv("WASM_POSIX_BINARY_RESOLVER_REPO_ROOT", repoRoot);
  });
  afterAll(() => vi.unstubAllEnvs());

  it("defers data until real speech, file detection and theme reads, then reuses it", async () => {
    const image = new Uint8Array(readFileSync(imagePath));
    const fs = KandeloImageFs.create();
    fs.loadImage(image);
    for (const path of [
      "/usr/share/espeak-ng-data/phondata",
      "/usr/share/misc/magic",
      "/usr/share/kandelo/themes/tokyo-night/theme.conf",
    ]) expect(fs.isPathDeferred(path), path).toBe(true);
    const bash = fs.readFile("/usr/bin/bash");
    let stdout = "";
    let stderr = "";
    const downloads: LazyDownloadEvent[] = [];
    const host = new NodeKernelHost({
      rootfsImage: image,
      onStdout: (_pid, data) => { stdout += new TextDecoder().decode(data); },
      onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
      onLazyDownload: (event) => downloads.push(event),
    });
    const kernel = readFileSync(resolveBinary("kernel.wasm"));
    await host.init(kernel.buffer.slice(kernel.byteOffset, kernel.byteOffset + kernel.byteLength));
    try {
      expect(downloads).toEqual([]);
      for (let iteration = 0; iteration < 2; iteration++) {
        stdout = "";
        stderr = "";
        const exit = await host.spawn(bash.buffer.slice(bash.byteOffset, bash.byteOffset + bash.byteLength) as ArrayBuffer, ["bash", "-c", command], {
          env: ["PATH=/usr/bin:/bin", "HOME=/home/maker", "USER=maker", "TMPDIR=/tmp"],
          cwd: "/home/maker",
          uid: 1000,
          gid: 1000,
          stdin: new Uint8Array(),
        });
        expect(exit, stderr).toBe(0);
        expect(stdout).toContain("speech-data-ok");
        expect(stdout).toContain("ASCII text");
        expect(stdout).toContain("Tokyo Night");
        for (const name of optionalData) {
          expect(downloads.filter(event => event.status === "complete" && event.url.endsWith(name)), name)
            .toHaveLength(1);
        }
      }
    } finally {
      await host.destroy();
    }
  }, 180_000);
});
