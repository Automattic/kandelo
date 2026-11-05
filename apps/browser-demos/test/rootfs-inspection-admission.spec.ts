import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "@playwright/test";
import { persistentBaseFixture } from "../../../host/test/fixtures/persistent-base-image";
import { opfsTest as test } from "./support/opfs-page";

const repository = resolve(import.meta.dirname, "../../..");
for (const policy of ["crc32c", "sha256"] as const) {
  for (const variant of ["directory", "resources"] as const) {
    test(`${policy} ${variant} resource refusal releases OPFS inspection and permits durable retry`, async ({ page, baseURL }) => {
      const temporary = mkdtempSync(join(tmpdir(), "kandelo-inspection-browser-"));
      try {
        const fixture = await persistentBaseFixture(temporary, policy, 4096, "deferred");
        const imageUrl = new URL("/inspection-base.img", baseURL).href;
        const kernelUrl = new URL("/inspection-kernel.wasm", baseURL).href;
        await page.route(imageUrl, route => route.fulfill({ body: readFileSync(fixture.path) }));
        await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(join(repository,
          "target/wasm32-unknown-unknown/release/kandelo_kernel.wasm")) }));
        await page.goto(new URL("/trap-signal-test.html", baseURL).href);
        const results = await page.evaluate(async parameters => {
          const root = await navigator.storage.getDirectory();
          const name = `inspection-${crypto.randomUUID()}`;
          const directory = await root.getDirectoryHandle(name, { create: true });
          let clean = true;
          const results: Array<Record<string, any>> = [];
          try {
            const source = await directory.getFileHandle("base", { create: true });
            await (await fetch(parameters.imageUrl)).body!.pipeTo(await source.createWritable());
            const kernelWasm = await (await fetch(parameters.kernelUrl)).arrayBuffer();
            for (const phase of ["exercise", "recover"]) {
              const worker = new Worker(parameters.workerUrl, { type: "module" });
              clean = false;
              try {
                const result = await new Promise<Record<string, any>>((resolve, reject) => {
                  worker.onmessage = event => resolve(event.data);
                  worker.onerror = event => reject(new Error(event.message));
                  worker.postMessage({ source, kernelWasm, binding: parameters.binding, name,
                    variant: parameters.variant, phase });
                });
                clean = result.closed === true;
                if (!clean) throw new Error(`inspection worker failed: ${JSON.stringify(result)}`);
                results.push(result);
              } finally { worker.terminate(); }
            }
            return results;
          } finally {
            if (clean) {
              await root.removeEntry(name, { recursive: true });
              const overlays = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
              for await (const filename of overlays.keys()) {
                if (filename.startsWith(name + ".")) await overlays.removeEntry(filename, { recursive: true });
              }
            }
          }
        }, { imageUrl, kernelUrl, binding: fixture.binding, variant,
          workerUrl: new URL(`/@fs/${join(repository, "apps/browser-demos/test/fixtures/inspection-admission-worker.ts")}`, baseURL).href });
        expect(results).toHaveLength(2);
        expect(results[0].failure).toMatchObject({ code: "ENOMEM", errno: 12 });
        expect(results[0].fatalErrors).toEqual([]);
        expect(results[0].state).toBe("original");
        expect(results[0].mode).toBe(0o640);
        expect(results[0].entries).toBeGreaterThan(0);
        expect(results[0].urls).toBeGreaterThan(0);
        expect(results[0].remaining).toBe(results[0].before);
        expect(results[0].ioAfter).toBe(results[0].ioBefore);
        expect(results[1].marker).toBe("usable journal");
        expect(results[1].fatalErrors).toEqual([]);
      } finally { rmSync(temporary, { recursive: true, force: true }); }
    });
  }
}
