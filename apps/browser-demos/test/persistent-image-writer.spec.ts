import { tmpdir } from "node:os";
import { writeCheckedUpgradeSource } from "../../../host/test/fixtures/kifs-upgrade-source";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "../playwright-test";
import { capacityProgram } from "../../../host/test/fixtures/kifs-v3-guest";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { opfsTest as test } from "./support/opfs-page";

const repository = resolve(import.meta.dirname, "../../..");

for (const policy of ["crc32c", "sha256"] as const) {
  test(`Rust writes and checks a ${policy} OPFS image before real kernel restart`, async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const imageModuleUrl = new URL("/persistent-image-writer.wasm", baseURL).href;
    const capacityUrl = new URL("/capacity.wasm", baseURL).href;
    await page.route(capacityUrl, route => route.fulfill({ body: readFileSync(capacityProgram) }));
    const kernelUrl = new URL("/persistent-image-writer-kernel.wasm", baseURL).href;
    await page.route(imageModuleUrl, route => route.fulfill({ body: readFileSync(resolveBinary("kandelo_image_module_positioned32.wasm")) }));
    await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(resolveBinary("kernel.wasm")) }));
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const result = await page.evaluate(async ({ workerUrl, kernelModuleUrl, imageModuleUrl, kernelUrl, capacityUrl, policy }) => {
      const root = await navigator.storage.getDirectory();
      const name = `persistent-writer-${crypto.randomUUID()}`;
      const directory = await root.getDirectoryHandle(name, { create: true });
      const file = await directory.getFileHandle("base", { create: true });
      const cancelFile = await directory.getFileHandle("cancelled", { create: true });
      const volumeFile = await directory.getFileHandle("v3.kifs", { create: true });
      const worker = new Worker(workerUrl, { type: "module" });
      const { BrowserKernel } = await import(kernelModuleUrl);
      let active: InstanceType<typeof BrowserKernel> | undefined;
      try {
        const moduleBytes = await (await fetch(imageModuleUrl)).arrayBuffer();
        const written = await new Promise<{
          error?: string; stack?: string;
          result: { payloadLength: number; physicalLength: number };
          binding: { identitySha256: string; dataCachePages: number; indexCachePages: number };
          phases: string[]; written: number; verified: number; value: string; mountedRead: number;
          progressCancelled: boolean; producerCancelled: boolean;
          volumeLength: number;
        }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Persistent image writer worker did not complete")), 90_000);
          worker.onmessage = event => { clearTimeout(timer); resolve(event.data); };
          worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
          worker.postMessage({ moduleBytes, file, cancelFile, volumeFile, policy }, [moduleBytes]);
        });
        if (written.error !== undefined) throw new Error(`${written.error}\n${written.stack}`);
        worker.terminate();
        const volume = await volumeFile.getFile();
        const header = new DataView(await volume.slice(0, 168).arrayBuffer());
        const staged = {
          magic: new TextDecoder().decode(new Uint8Array(header.buffer, 0, 4)),
          version: header.getUint32(4, true),
          capacity: Number(header.getBigUint64(24, true)),
          length: volume.size,
        };
        const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
        const guest = await (await fetch(capacityUrl)).arrayBuffer();
        const profile = policy === "crc32c" ? "custom" : "development";
        let output = "";
        const write = (bytes: Uint8Array) => { output += new TextDecoder().decode(bytes); };
        const boot = async (requireExisting = false, requested?: "legacy" | "development" | "custom") => {
          active = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024, maxMemoryPages: 1024,
            memoryProfile: "constrained", onStdout: write, onStderr: write });
          await active.initFromOpfsImage({ kernelWasm, vfsImageFile: file, persistentImageBinding: written.binding,
            experimentalResizablePersistenceName: name, persistentComputerName: name,
            requireExistingRootfsPersistence: requireExisting, kifsUpgradeProfile: requested });
          return active;
        };
        const inspect = async (host: InstanceType<typeof BrowserKernel>, phase: string) => {
          output = "";
          const code = await host.spawn(guest, ["kifs-capacity", phase, "/"], { uid: 0, gid: 0 });
          if (code !== 0) throw new Error(`saved filesystem guest failed (${code}): ${output}`);
          const objects = output.match(/^saved objects .+$/m)?.[0];
          const geometry = output.match(/^geometry (\d+) (\d+)$/m);
          if (objects === undefined || !geometry) throw new Error("Missing guest filesystem observations: " + output);
          return { objects, blocks: geometry[1], files: geometry[2] };
        };
        const first = await boot(false, "legacy");
        const initial = new TextDecoder().decode((await first.readFileFromVfs("/link"))!);
        await first.writeFileToVfs("/state", new TextEncoder().encode("persisted"), 0o640);
        const seeded = await inspect(first, "seed-saved");
        await first.destroy();
        active = undefined;
        const second = await boot(true, "legacy");
        const recovered = new TextDecoder().decode((await second.readFileFromVfs("/link"))!);
        await second.destroy();
        active = undefined;
        const upgraded = await boot(true, profile);
        const after = await inspect(upgraded, "check-saved");
        await upgraded.writeFileToVfs("/after-upgrade", Uint8Array.of(83), 0o600);
        await upgraded.destroy();
        active = undefined;
        const reopened = await boot(true);
        const confirmed = await inspect(reopened, "check-saved");
        const value = (await reopened.readFileFromVfs("/after-upgrade"))?.[0];
        await reopened.destroy();
        active = undefined;
        return { ...written, initial, recovered, staged, seeded, after, confirmed, profile, newByte: value };
      } finally {
        worker.terminate();
        await active?.destroy();
        const overlay = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
        for await (const filename of overlay.keys()) {
          if (filename.startsWith(`${name}.`)) await overlay.removeEntry(filename, { recursive: true });
        }
        await root.removeEntry(name, { recursive: true });
      }
    }, {
      workerUrl: new URL(`/@fs/${resolve(repository, "apps/browser-demos/test/fixtures/persistent-image-writer-worker.ts")}`, baseURL).href,
      kernelModuleUrl: new URL(`/@fs/${resolve(repository, "host/src/browser-kernel-host.ts")}`, baseURL).href,
      imageModuleUrl, kernelUrl, capacityUrl, policy,
    });
    expect(result.phases).toEqual(["write", "verify"]);
    expect(result.progressCancelled).toBe(true);
    expect(result.producerCancelled).toBe(true);
    expect(result.written).toBe(result.result.payloadLength);
    expect(result.verified).toBe(result.result.payloadLength);
    expect(result.mountedRead).toBeLessThan(result.result.physicalLength / 2);
    expect(result.value).toBe("original");
    expect(result.initial).toBe("original");
    expect(result.recovered).toBe("persisted");
    expect(result.after).toEqual({ objects: result.seeded.objects,
      blocks: result.profile === "development" ? "262144" : result.seeded.blocks, files: "0" });
    expect(result.confirmed).toEqual(result.after);
    expect(result.newByte).toBe(83);
    expect(result.staged).toEqual({ magic: "KIFS", version: 3, capacity: 262_144, length: result.volumeLength });
    expect(result.volumeLength).toBeLessThan(1024 * 1024);
  });
}

test("OPFS recovers each interrupted KIFS upgrade and reuses its staging files", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const temporary = mkdtempSync(resolve(tmpdir(), "kifs-upgrade-cuts-"));
  try {
    const { identity, path } = await writeCheckedUpgradeSource(temporary);
    const sourceUrl = new URL("/cut-source.img", baseURL).href;
    const kernelUrl = new URL("/cut-kernel.wasm", baseURL).href;
    await page.route(sourceUrl, route => route.fulfill({ body: readFileSync(path) }));
    await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(process.env.KANDELO_KIFS_BENCH_KERNEL ?? resolveBinary("kernel.wasm")) }));
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    await page.evaluate(async ({ identity, sourceUrl, kernelUrl, cutsUrl, locksUrl, expectIndexAppendQuota }) => {
      const { exerciseOwnerLoss, upgradeCuts } = await import(cutsUrl) as typeof import("../../../host/test/fixtures/kifs-upgrade-cuts");
      const { browserPersistenceJournalLockName } = await import(locksUrl);
      const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
      const root = await navigator.storage.getDirectory();
      const overlay = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
      const prefix = "cuts-" + crypto.randomUUID();
      const base = await root.getFileHandle(prefix, { create: true });
      const writer = await base.createWritable();
      await writer.write(await (await fetch(sourceUrl)).arrayBuffer());
      await writer.close();
      try {
        for (const cut of upgradeCuts) {
          const name = prefix + "-" + cut;
          await exerciseOwnerLoss(cut, async action => {
            const worker = new Worker("/test/fixtures/kifs-upgrade-cut-worker.ts", { type: "module" });
            try {
              return await new Promise((resolve, reject) => {
                worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
                worker.onerror = event => reject(new Error(event.message));
                worker.postMessage({ action, name, base, identity, kernelWasm });
              });
            } finally {
              worker.terminate();
              await navigator.locks.request(browserPersistenceJournalLockName(name), () => {});
            }
          }, expectIndexAppendQuota);
        }
      } finally {
        for await (const filename of overlay.keys()) {
          if (filename.startsWith(prefix + "-")) await overlay.removeEntry(filename);
        }
        await root.removeEntry(prefix);
      }
    }, { identity, sourceUrl, kernelUrl, expectIndexAppendQuota: process.env.KANDELO_KIFS_EXPECT_INDEX_QUOTA === "1",
      cutsUrl: new URL("/@fs/" + resolve(repository, "host/test/fixtures/kifs-upgrade-cuts.ts"), baseURL).href,
      locksUrl: new URL("/@fs/" + resolve(repository, "host/src/browser-persistence-journal-lease.ts"), baseURL).href,
    });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
