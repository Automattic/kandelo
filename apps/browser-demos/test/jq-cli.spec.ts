import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { SHELL_LAZY_BINARY_SPECS } from "../../../images/vfs/lib/init/shell-binaries";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { ABI_VERSION } from "../../../host/src/generated/abi";
import { ensureDirRecursive } from "../../../host/src/vfs/image-helpers";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

test("lazy jq filters JSON with regexes and decimal precision in a browser", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const bytes = readFileSync(resolveBinary("programs/jq.wasm"));
  const programUrl = new URL("/jq-test.wasm", baseURL).href;
  const kernelUrl = new URL("/jq-test-kernel.wasm", baseURL).href;
  const imageUrl = new URL("/jq-test.vfs", baseURL).href;
  const imageCapacity = 8 * 1024 * 1024;
  const fs = MemoryFileSystem.create(
    new SharedArrayBuffer(1024 * 1024, { maxByteLength: imageCapacity }),
    imageCapacity,
  );
  fs.setImageMetadata({ version: 1, kernelAbi: ABI_VERSION });
  ensureDirRecursive(fs, "/usr/bin");
  ensureDirRecursive(fs, "/bin");
  const spec = SHELL_LAZY_BINARY_SPECS.find(({ id }) => id === "jq")!;
  fs.registerLazyFile(spec.vfsPath, programUrl, bytes.byteLength, 0o755);
  for (const alias of spec.symlinks) fs.symlink(spec.vfsPath, alias);
  const image = await fs.saveImage();
  for (const [url, body] of [
    [programUrl, bytes],
    [kernelUrl, readFileSync(resolveBinary("kernel.wasm"))],
    [imageUrl, Buffer.from(image)],
  ] as const) {
    await page.route(url, (route) => route.fulfill({ body }));
  }
  await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);
  const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
  const results = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl }) => {
    const { BrowserKernel } = await import(moduleUrl);
    let stdout = "";
    let stderr = "";
    const downloads: any[] = [];
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onStdout: (data: Uint8Array) => { stdout += new TextDecoder().decode(data); },
      onStderr: (data: Uint8Array) => { stderr += new TextDecoder().decode(data); },
    });
    kernel.subscribeLazyDownloads((event: any) => downloads.push(event));
    try {
      await kernel.initFromImage({
        kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
        vfsImage: new Uint8Array(await (await fetch(imageUrl)).arrayBuffer()),
      });
      const downloadsAtBoot = downloads.length;
      const run = async (args: string[], stdin = "", path = "/usr/bin/jq") => {
        stdout = "";
        stderr = "";
        const { exit } = await kernel.spawnFromVfs(path, ["jq", ...args], {
          stdin: new TextEncoder().encode(stdin),
        });
        return { exitCode: await exit, stdout, stderr };
      };
      return {
        version: await run(["--version"]),
        filter: await run(["-c", "[.items[] | select(.active) | .value] | add"],
          '{"items":[{"active":true,"value":2},{"active":false,"value":99},{"active":true,"value":3}]}'),
        regex: await run(["-nc", '"café-42" | capture("(?<word>\\\\p{L}+)-(?<number>[0-9]+)")']),
        decimal: await run(["-nc", "123456789012345678901234567890"], "", "/bin/jq"),
        falseStatus: await run(["-ne", "false"]),
        downloadsAtBoot,
        completedDownloads: downloads.filter(({ status }) => status === "complete").length,
      };
    } finally {
      await kernel.destroy();
    }
  }, { moduleUrl: new URL(`/@fs/${modulePath}`, baseURL).href, kernelUrl, imageUrl });
  for (const name of ["version", "filter", "regex", "decimal"] as const) {
    expect(results[name].exitCode, results[name].stderr).toBe(0);
    expect(results[name].stderr).toBe("");
  }
  expect(results.version.stdout).toBe("jq-1.8.2\n");
  expect(results.filter.stdout).toBe("5\n");
  expect(results.regex.stdout).toBe('{"word":"café","number":"42"}\n');
  expect(results.decimal.stdout).toBe("123456789012345678901234567890\n");
  expect(results.falseStatus.exitCode).toBe(1);
  expect(results.downloadsAtBoot).toBe(0);
  expect(results.completedDownloads).toBe(1);
});
