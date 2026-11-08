import { expect, test } from "../playwright-test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { ABI_CONTRACT_SECTION, readWasmCustomSectionPayload } from "../../../host/src/constants";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

const repoRoot = resolve(import.meta.dirname, "../../..");
test.skip(process.env.KANDELO_GO_WASM32_TESTS !== "1", "Build the isolated wasm32 fixtures and set KANDELO_GO_WASM32_TESTS=1");

const fixtures = ["runtime", "basic", ...(process.env.KANDELO_GO_WASM32_CGO_TESTS === "1"
  ? ["cgo-basic", "cgo-typed", "cgo-callback-same", "cgo-callback-pthread", "cgo-callback-stress"] : [])];
for (const fixture of fixtures) {
  test(`Kandelo wasm32 ${fixture}`, async ({ page, baseURL }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    const program = readFileSync(resolve(repoRoot, `.context/go-wasm32-prototype/${fixture === "cgo-callback-stress" ? "cgo-callback-pthread" : fixture}.wasm`));
    const kernel = readFileSync(resolveBinary("kernel.wasm"));
    const digest = (bytes: Buffer) => readWasmCustomSectionPayload(Uint8Array.from(bytes).buffer, ABI_CONTRACT_SECTION);
    expect(digest(kernel)?.length).toBe(32);
    expect(digest(program)).toEqual(digest(kernel));
    const image = KandeloImageFs.create();
    image.setImageCapacity(2 * 1024 * 1024);
    image.mkdir("/etc", 0o755);
    image.mkdir("/tmp", 0o777);
    image.createFileWithOwner("/etc/go-browser-input", 0o644, 0, 0, new TextEncoder().encode("browser fixture\n"));
    const resources = { "program.wasm": program, "kernel.wasm": kernel, "root.vfs": Buffer.from(await image.saveImage()) };
    for (const [name, body] of Object.entries(resources)) {
      await page.route(new URL(`/__wasm32_${name}`, baseURL).href, route => route.fulfill({ status: 200, body, contentType: name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream" }));
    }
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const result = await page.evaluate(async ({ hostUrl, fixture }) => {
      const { BrowserKernel } = await import(/* @vite-ignore */ hostUrl);
      const [program, kernelWasm, vfsImage] = await Promise.all(["program.wasm", "kernel.wasm", "root.vfs"].map(async name => {
        const response = await fetch(`/__wasm32_${name}`);
        if (!response.ok) throw Error(`Fixture fetch failed: ${name} ${response.status}`);
        return response.arrayBuffer();
      }));
      const decoder = new TextDecoder();
      let stdout = "", stderr = "";
      const diagnostics: unknown[] = [];
      const kernel = new BrowserKernel({ kernelOwnedFs: true,
        onStdout: (bytes: Uint8Array) => { stdout += decoder.decode(bytes); },
        onStderr: (bytes: Uint8Array) => { stderr += decoder.decode(bytes); },
        onHostDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic),
      });
      try {
        await kernel.initFromImage({ kernelWasm, vfsImage: new Uint8Array(vfsImage) });
        const exitCode = await kernel.spawn(program, fixture === "basic" ? ["go-basic", "alpha", "beta"] : fixture === "cgo-callback-stress" ? ["callback", "stress"] : [fixture], { env: ["KANDELO_GO_BROWSER=present", "KANDELO_CGO_PROBE=cgo-startup"] });
        return { exitCode, stdout, stderr, diagnostics };
      } finally { await kernel.destroy(); }
    }, { hostUrl: new URL(`/@fs/${resolve(repoRoot, "host/src/browser-kernel-host.ts")}`, baseURL).href, fixture });
    await test.info().attach("guest-result", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.diagnostics).toEqual([]);
    expect(errors).toEqual([]);
    if (fixture === "runtime") {
      const probe = JSON.parse(result.stdout);
      expect(probe.goos).toBe("kandelo");
      expect(probe.goarch).toBe("wasm32");
      expect(probe.checks).toHaveLength(9);
      expect(probe.layout).toEqual({ pointerBytes: 4, intBytes: 4, int64Align: 8, sampleBytes: 24, sampleAlign: 8, pointerOffset: 4, wideOffset: 8, chainOffset: 16, tailOffset: 20, alignedBytes: 24, alignedWideOffset: 8 });
    } else {
      const markers: Record<string, string> = { basic: "GO BASIC PASS", "cgo-basic": "CGO ABS PASS", "cgo-typed": "WASM32 TYPED CGO PASS", "cgo-callback-same": "CGO CALLBACK PASS", "cgo-callback-pthread": "CGO CALLBACK PASS", "cgo-callback-stress": "CGO CALLBACK STRESS PASS" };
      expect(result.stdout).toContain(markers[fixture]);
    }
  });
}
