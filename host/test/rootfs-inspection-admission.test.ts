import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { persistentBaseFixture } from "./fixtures/persistent-base-image";

const repository = resolve(import.meta.dirname, "../..");
const kernelBytes = readFileSync(join(repository, "target/wasm32-unknown-unknown/release/kandelo_kernel.wasm"));
const fixtureUrl = new URL("./fixtures/inspection-admission-worker.ts", import.meta.url).href;
const registration = new URL("../node_modules/tsx/dist/esm/api/index.mjs", import.meta.url).href;

for (const policy of ["crc32c", "sha256"] as const) {
  for (const variant of ["directory", "resources"] as const) {
    it(`${policy} ${variant} inspection refuses host memory without poisoning the persistent worker`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "kandelo-inspection-admission-"));
      let worker: Worker | undefined;
      try {
        const fixture = await persistentBaseFixture(directory, policy, 4096, "deferred");
        for (const phase of ["exercise", "recover"]) {
          worker = new Worker(`import {register} from ${JSON.stringify(registration)}; register(); await import(${JSON.stringify(fixtureUrl)});`, {
            eval: true, workerData: { imagePath: fixture.path, binding: fixture.binding, directory, variant, phase,
              kernelWasm: kernelBytes.buffer.slice(kernelBytes.byteOffset, kernelBytes.byteOffset + kernelBytes.byteLength) },
          });
          const result = await new Promise<Record<string, any>>((resolve, reject) => {
            worker!.once("message", resolve);
            worker!.once("error", reject);
            worker!.once("exit", code => reject(new Error(`inspection worker exited before reporting (${code})`)));
          });
          expect(result.failures).toEqual([]);
          expect(result.fatalErrors).toEqual([]);
          if (phase === "exercise") {
            expect(result.failure).toMatchObject({ code: "ENOMEM", errno: 12 });
            expect(result.state).toBe("original");
            expect(result.mode).toBe(0o640);
            expect(result.entries).toBeGreaterThan(0);
            expect(result.urls).toBeGreaterThan(0);
            expect(result.remaining).toBe(result.before);
            expect(result.ioAfter).toBe(result.ioBefore);
          } else expect(result.marker).toBe("usable journal");
          await worker.terminate();
          worker = undefined;
        }
      } finally {
        await worker?.terminate();
        rmSync(directory, { recursive: true, force: true });
      }
    }, 60_000);
  }
}
