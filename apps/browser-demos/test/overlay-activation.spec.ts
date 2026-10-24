import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { opfsTest as test } from "./support/opfs-page";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

const repoRoot = resolve(import.meta.dirname, "../../..");

for (const damage of ["magic", "version", "checksum", "short"] as const) {
  test(`OPFS unsealed ${damage} header refusal does not publish an activation`, async ({ page, baseURL }, testInfo) => {
    test.setTimeout(60_000);
    const filesystem = KandeloImageFs.create();
    filesystem.setImageCapacity(8 * 1024 * 1024);
    filesystem.mkdir("/bin", 0o755);
    filesystem.writeFile("/bin/persistence-overwrite", readFileSync(resolveBinary("test-fixtures/wasm32/persistence-overwrite.wasm")), 0o755);
    filesystem.writeFile("/state", new TextEncoder().encode("abcdefgh"), 0o644);
    const image = await filesystem.saveImage();
    const kernelUrl = new URL("/header-policy-kernel.wasm", baseURL).href;
    const imageUrl = new URL("/header-policy-image.vfs", baseURL).href;
    await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(resolveBinary("kernel.wasm")) }));
    await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(image) }));
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const result = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl, damage }) => {
      const { BrowserKernel } = await import(moduleUrl);
      const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
      const name = "header-policy-" + crypto.randomUUID();
      const base = await directory.getFileHandle(`${name}.base`, { create: true });
      const writer = await base.createWritable();
      await writer.write(await (await fetch(imageUrl)).arrayBuffer());
      await writer.close();
      const create = () => new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024 });
      const init = (kernel: InstanceType<typeof BrowserKernel>, existing: boolean) => kernel.initFromOpfsImage({
        kernelWasm, vfsImageFile: base, persistentComputerName: name,
        experimentalResizablePersistenceName: name, requireExistingRootfsPersistence: existing,
      });
      let closed = true;
      try {
        const first = create();
        closed = false;
        try {
          await init(first, false);
          const { exit } = await first.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite"]);
          if (await exit !== 0) throw new Error("initial guest fsync failed");
        } finally { await first.destroy(); closed = true; }
        await directory.removeEntry(`${name}.activation0`);
        await directory.removeEntry(`${name}.activation1`);
        const journal = await directory.getFileHandle(`${name}.journal`);
        let bytes = new Uint8Array(await (await journal.getFile()).arrayBuffer());
        if (damage === "short") bytes = bytes.slice(0, 40);
        else bytes[damage === "magic" ? 0 : damage === "version" ? 4 : 40] ^= 1;
        const corrupt = await journal.createWritable();
        await corrupt.write(bytes);
        await corrupt.close();
        const rejected = create();
        let error = "";
        closed = false;
        try { await init(rejected, true); }
        catch (failure) { error = String(failure); }
        finally { await rejected.destroy(); closed = true; }
        const after = new Uint8Array(await (await journal.getFile()).arrayBuffer());
        const controls: string[] = [];
        for await (const [entry] of directory.entries()) {
          if (entry === `${name}.activation0` || entry === `${name}.activation1`) controls.push(entry);
        }
        return { error, unchanged: bytes.length === after.length && bytes.every((byte, index) => byte === after[index]), controls };
      } finally {
        if (closed) for await (const [entry] of directory.entries()) {
          if (entry.startsWith(name + ".")) await directory.removeEntry(entry, { recursive: true });
        }
      }
    }, { moduleUrl: new URL(`/@fs/${resolve(repoRoot, "host/src/browser-kernel-host.ts")}`, baseURL).href,
      kernelUrl, imageUrl, damage });
    await testInfo.attach("journal-header-refusal", { body: JSON.stringify(result), contentType: "application/json" });
    expect(result.error).toContain("no valid journal generation");
    expect(result).toMatchObject({ unchanged: true, controls: [] });
  });
}

for (const mode of ["fixed", "resizable"] as const) {
  for (const damage of ["seal", "index", "journal", "committed-record"] as const) {
    test(`OPFS ${mode} active ${damage} damage never rolls back post-compaction fsync`, async ({ page, baseURL }, testInfo) => {
      test.setTimeout(120_000);
      const filesystem = KandeloImageFs.create();
      filesystem.setImageCapacity(8 * 1024 * 1024);
      filesystem.mkdir("/bin", 0o755);
      filesystem.writeFile("/bin/persistence-overwrite", readFileSync(resolveBinary("test-fixtures/wasm32/persistence-overwrite.wasm")), 0o755);
      filesystem.writeFile("/state", new TextEncoder().encode("abcdefgh"), 0o644);
      const image = await filesystem.saveImage();
      const kernelUrl = new URL("/activation-kernel.wasm", baseURL).href;
      const imageUrl = new URL("/activation-image.vfs", baseURL).href;
      await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(resolveBinary("kernel.wasm")) }));
      await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(image) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl, mode, damage }) => {
        const { BrowserKernel } = await import(moduleUrl);
        const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
        const name = "activation-" + crypto.randomUUID();
        const base = await directory.getFileHandle(`${name}.base`, { create: true });
        const writer = await base.createWritable();
        await writer.write(await (await fetch(imageUrl)).arrayBuffer());
        await writer.close();
        const create = () => new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024 });
        const init = (kernel: InstanceType<typeof BrowserKernel>, existing: boolean) => kernel.initFromOpfsImage({
          kernelWasm, vfsImageFile: base, persistentComputerName: name,
          ...(mode === "fixed" ? { experimentalFixedPersistenceName: name } : { experimentalResizablePersistenceName: name }),
          requireExistingRootfsPersistence: existing,
        });
        const digest = async (file: FileSystemFileHandle) => Array.from(new Uint8Array(
          await crypto.subtle.digest("SHA-256", await (await file.getFile()).arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("");
        let closed = true;
        try {
          const first = create();
          closed = false;
          try {
            await init(first, false);
            const { exit } = await first.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite"]);
            if (await exit !== 0) throw new Error("initial guest fsync failed");
          } finally { await first.destroy(); closed = true; }
          const legacy = await directory.getFileHandle(`${name}.journal`);
          const source = new Uint8Array(await (await legacy.getFile()).arrayBuffer());
          const sourceView = new DataView(source.buffer);
          const length = sourceView.getUint32(76, true);
          if (length < 60 || 72 + length > source.length) throw new Error("invalid fixture transaction");
          const transaction = source.slice(72, 72 + length);
          const transactionView = new DataView(transaction.buffer);
          let sequence = 0n;
          for (let position = 72; position < source.length;) {
            const frameLength = sourceView.getUint32(position + 4, true);
            if (frameLength < 60 || position + frameLength > source.length) throw new Error("invalid fixture framing");
            sequence = sourceView.getBigUint64(position + 8, true);
            position += frameLength;
          }
          const copies = Math.ceil((32 * 1024 * 1024 - source.length) / length) + 1;
          const expanded = new Uint8Array(source.length + copies * length);
          expanded.set(source);
          for (let index = 0; index < copies; index++) {
            transactionView.setBigUint64(8, ++sequence, true);
            transaction.set(new Uint8Array(await crypto.subtle.digest("SHA-256", transaction.slice(0, -36))), length - 36);
            expanded.set(transaction, source.length + index * length);
          }
          const expand = await legacy.createWritable();
          await expand.write(expanded);
          await expand.close();
          const second = create();
          let pages = 0;
          closed = false;
          try {
            await init(second, true);
            const before = new TextDecoder().decode((await second.readFileFromVfs("/state"))!);
            if (before !== "XYcdefgh") throw new Error(`compaction changed source state: ${before}`);
            const { exit } = await second.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite", "mmap-fsync"]);
            if (await exit !== 0) throw new Error("post-compaction fsync failed");
            const current = new TextDecoder().decode((await second.readFileFromVfs("/state"))!);
            if (current !== "MScdefgh") throw new Error(`post-compaction state missing: ${current}`);
            pages = await second.getKernelMemoryPages();
          } finally { await second.destroy(); closed = true; }
          const active = await directory.getFileHandle(`${name}.g0.${damage === "committed-record" ? "journal" : damage}`);
          let bytes = new Uint8Array(await (await active.getFile()).arrayBuffer());
          if (damage === "committed-record") {
            const fields = new DataView(bytes.buffer);
            let sequence = 0n;
            for (let position = 72; position < bytes.length;) {
              const length = fields.getUint32(position + 4, true);
              if (length < 60 || position + length > bytes.length) throw new Error("invalid active transaction");
              sequence = fields.getBigUint64(position + 8, true);
              position += length;
            }
            const record = new Uint8Array(83);
            const view = new DataView(record.buffer);
            record.set([75, 84, 88, 78]);
            view.setUint32(4, record.length, true);
            view.setBigUint64(8, sequence + 1n, true);
            view.setUint32(16, 1, true);
            view.setUint32(20, (~record.length) >>> 0, true);
            record.set([1, 255], 24);
            record.set(new Uint8Array(await crypto.subtle.digest("SHA-256", record.slice(0, -36))), record.length - 36);
            record.set([68, 79, 78, 69], record.length - 4);
            const appended = new Uint8Array(bytes.length + record.length);
            appended.set(bytes);
            appended.set(record, bytes.length);
            bytes = appended;
          } else bytes[0] ^= 1;
          const corrupt = await active.createWritable();
          await corrupt.write(bytes);
          await corrupt.close();
          const sourceDigest = await digest(legacy);
          const activeDigest = await digest(active);
          const rejected = create();
          let error = "";
          closed = false;
          try { await init(rejected, true); }
          catch (failure) { error = String(failure); }
          finally { await rejected.destroy(); closed = true; }
          return { error, pages, sourceUnchanged: sourceDigest === await digest(legacy), activeUnchanged: activeDigest === await digest(active) };
        } finally {
          if (closed) for await (const [entry] of directory.entries()) {
            if (entry.startsWith(name + ".")) await directory.removeEntry(entry, { recursive: true });
          }
        }
      }, { moduleUrl: new URL(`/@fs/${resolve(repoRoot, "host/src/browser-kernel-host.ts")}`, baseURL).href,
        kernelUrl, imageUrl, mode, damage });
      await testInfo.attach("active-generation-refusal", { body: JSON.stringify(result), contentType: "application/json" });
      expect(result.error).toContain("no valid journal generation");
      expect(result.pages).toBeLessThanOrEqual(1024);
      expect(result).toMatchObject({ sourceUnchanged: true, activeUnchanged: true });
    });
  }
}
