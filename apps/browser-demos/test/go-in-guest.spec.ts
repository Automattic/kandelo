import { expect, test } from "../playwright-test";
import { fileURLToPath } from "node:url";
import {
  goGuestAbiDigest, goGuestArtifacts, goGuestLazyBase, goGuestOutput, goGuestOutputPath,
  goGuestShellCommand, goGuestShellOptions,
} from "../../../host/test/fixtures/go-in-guest";

test("builds and runs a local Go module offline from the Kandelo shell @slow", async ({ page, baseURL }) => {
  test.setTimeout(1_200_000);
  const { kernel, shell, archive } = goGuestArtifacts();
  const origin = new URL(baseURL!).origin;
  await page.context().route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.fallback();
    return route.abort("internetdisconnected");
  });
  const kernelUrl = "/__go_guest_kernel.wasm";
  const shellUrl = "/__go_guest_shell.vfs.zst";
  const archiveFixtureUrl = "/__go_guest_archive.zip";
  await page.route(kernelUrl, (route) => route.fulfill({ body: Buffer.from(kernel) }));
  await page.route(shellUrl, (route) => route.fulfill({ body: Buffer.from(shell) }));
  await page.route(archiveFixtureUrl, (route) => route.fulfill({ body: Buffer.from(archive.bytes) }));
  await page.goto("/trap-signal-test.html");

  const moduleUrl = (file: string) => `/@fs/${fileURLToPath(new URL(`../../../host/src/${file}`, import.meta.url))}`;
  const result = await page.evaluate(async (fixture) => {
    const [{ BrowserKernel }, { ABI_CONTRACT_SECTION, readWasmCustomSectionPayload }] = await Promise.all([
      import(/* @vite-ignore */ fixture.kernelModule),
      import(/* @vite-ignore */ fixture.constantsModule),
    ]);
    async function read(url: string) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Fixture fetch failed: ${url}`);
      return response.arrayBuffer();
    }
    const [kernelWasm, image, archiveBytes] = await Promise.all(
      [fixture.kernelUrl, fixture.shellUrl, fixture.archiveFixtureUrl].map(read),
    );
    let stdout = "";
    let stderr = "";
    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();
    const host = new BrowserKernel({
      onStdout: (bytes: Uint8Array) => { stdout += stdoutDecoder.decode(bytes, { stream: true }); },
      onStderr: (bytes: Uint8Array) => { stderr += stderrDecoder.decode(bytes, { stream: true }); },
    });
    try {
      await host.initFromImage({
        kernelWasm,
        vfsImage: new Uint8Array(image),
        lazyUrlBase: fixture.lazyBase,
        lazyAssetDirectory: fixture.lazyBase,
        closedLazyAssets: [{ ...fixture.archive, bytes: new Uint8Array(archiveBytes) }],
      });
      const process = await host.spawnFromVfs("/bin/bash", ["bash", "-ec", fixture.command], fixture.options);
      const status = await process.exit;
      const wasm: Uint8Array | null = status === 0 ? await host.readFileFromVfs(fixture.output) : null;
      const digest: Uint8Array | null = wasm
        ? readWasmCustomSectionPayload(wasm.slice().buffer, ABI_CONTRACT_SECTION) : null;
      return { status, stdout, stderr, digest: digest && Array.from(digest) };
    } finally {
      await host.destroy();
    }
  }, {
    kernelModule: moduleUrl("browser-kernel-host.ts"), constantsModule: moduleUrl("constants.ts"),
    kernelUrl, shellUrl, archiveFixtureUrl,
    archive: { url: archive.url, sha256: archive.sha256, size: archive.size },
    lazyBase: goGuestLazyBase,
    command: goGuestShellCommand(), options: goGuestShellOptions, output: goGuestOutputPath,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(goGuestOutput);
  for (const tool of ["compile", "asm", "link"]) {
    expect(result.stderr).toContain(`/usr/lib/go/pkg/tool/kandelo_wasm32/${tool} `);
  }
  const digest = goGuestAbiDigest(kernel);
  expect(digest).not.toBeNull();
  expect(result.digest).toEqual(Array.from(digest!));
});
