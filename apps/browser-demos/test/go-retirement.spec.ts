import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

for (const mode of ["pure", "cgo"]) {
  test(`blocked Go ${mode} guest retires cooperatively during machine shutdown`, async ({ page, baseURL }) => {
    test.skip(process.env.KANDELO_GO_BROWSER_TESTS !== "1", "Build Go retirement fixtures and set KANDELO_GO_BROWSER_TESTS=1");
    const assets = {
      program: readFileSync(resolve("../../.context/go-retirement", `${mode}.wasm`)),
      kernel: readFileSync(resolveBinary("kernel.wasm")),
      image: Buffer.from(await KandeloImageFs.create().saveImage()),
    };
    await page.route("**/__go-retirement/*", route => {
      const name = new URL(route.request().url()).pathname.split("/").at(-1) as keyof typeof assets;
      return route.fulfill({ status: 200, body: assets[name], contentType: "application/octet-stream" });
    });
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const result = await page.evaluate(async browserKernelUrl => {
      const { BrowserKernel } = await import(/* @vite-ignore */ browserKernelUrl);
      const [program, kernelWasm, image] = await Promise.all(["program", "kernel", "image"].map(async name => {
        const response = await fetch(`/__go-retirement/${name}`);
        if (!response.ok) throw new Error(`fixture fetch failed: ${name}: ${response.status}`);
        return response.arrayBuffer();
      }));
      const progress: { phase: string; total: number; completed: number }[] = [];
      const diagnostics: unknown[] = [];
      let stdout = "";
      let stderr = "";
      let ready!: () => void;
      const started = new Promise<void>(resolve => { ready = resolve; });
      const kernel = new BrowserKernel({
        kernelOwnedFs: true,
        onStdout: (bytes: Uint8Array) => {
          stdout += new TextDecoder().decode(bytes);
          if (stdout.includes("GO RETIREMENT READY")) ready();
        },
        onStderr: (bytes: Uint8Array) => { stderr += new TextDecoder().decode(bytes); },
        onHostDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic),
      });
      kernel.subscribeDestroyProgress((event: { phase: string; total: number; completed: number }) => progress.push(event));
      try {
        await kernel.initFromImage({ kernelWasm, vfsImage: new Uint8Array(image) });
        const exit = kernel.spawn(program, ["go-retirement"]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            started,
            exit.then((code: number) => { throw new Error(`guest exited before retirement: ${code}; ${stderr}`); }),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error(`guest startup timed out; ${stderr}`)), 30_000);
            }),
          ]);
        } finally { clearTimeout(timer); }
        await kernel.destroy();
        return { progress, diagnostics, stdout, stderr };
      } finally { await kernel.destroy(); }
    }, new URL(`/@fs${resolve("../../host/src/browser-kernel-host.ts")}`, baseURL).href);
    expect(result.progress.filter(event => event.phase === "draining").at(-1))
      .toMatchObject({ total: 1, completed: 1 });
    expect(result.stderr).toBe("");
    expect(result.diagnostics).toEqual([]);
  });
}
