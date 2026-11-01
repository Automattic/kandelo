import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { test } from "./support/persistent-page";
import { softwareImage } from "../../../host/test/fixtures/package-upgrade-image";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { PACKAGE_MAINTENANCE_WIRE as wire } from "../../../host/src/generated/abi";

test("persistent package activation resumes after reload and rolls back without losing user data", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const before = await softwareImage(1, baseURL);
  const after = await softwareImage(2, baseURL);
  const kernel = readFileSync(resolveBinary("kernel.wasm"));
  const root = resolve(import.meta.dirname, "../../..");
  const moduleUrl = new URL(`/@fs/${root}/host/src/browser-kernel-host.ts`, baseURL).href;
  const clientUrl = new URL(`/@fs/${root}/apps/browser-demos/pages/kandelo/kernel-host/package-upgrade-client.ts`, baseURL).href;
  const kernelUrl = new URL("/package-upgrade-kernel.wasm", baseURL).href;
  const imageUrl = new URL("/package-upgrade-base.vfs", baseURL).href;
  const inventoryUrl = new URL("/package-upgrade-target.inventory", baseURL).href;
  const bodyBase = new URL("/package-upgrade-body", baseURL).href;
  const unexpectedFetches: string[] = [];
  const lazyFetches: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(String(error)));
  await page.route(kernelUrl, route => route.fulfill({ body: kernel }));
  await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(before.bytes) }));
  await page.route(inventoryUrl, route => route.fulfill({ body: Buffer.from(after.inventory) }));
  await page.route(before.lazyUri, route => { unexpectedFetches.push(route.request().url()); return route.abort(); });
  await page.route(after.lazyUri, route => {
    lazyFetches.push(route.request().url());
    return route.fulfill({ body: Buffer.from(after.lazy) });
  });
  await page.route(`${bodyBase}?*`, route => {
    const query = new URL(route.request().url()).searchParams;
    const path = query.get("path");
    const bytes = path === null ? undefined : after.bodies.get(path);
    const offset = Number(query.get("offset"));
    const length = Number(query.get("length"));
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > 65536) {
      return route.fulfill({ status: 400, body: "Invalid package range" });
    }
    return route.fulfill({ status: bytes ? 200 : 404, body: bytes ? Buffer.from(bytes.subarray(offset, offset + length)) : "Missing package fixture" });
  });
  await page.route("https://packages.invalid/**", route => {
    unexpectedFetches.push(route.request().url());
    return route.abort();
  });
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const name = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl, inventoryUrl }) => {
    const { BrowserKernel } = await import(moduleUrl);
    const host = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024 });
    const name = `package-upgrade-${crypto.randomUUID()}`;
    const bytes = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());
    try {
      await host.initFromImage({ kernelWasm: (await bytes(kernelUrl)).buffer,
        vfsImage: await bytes(imageUrl), experimentalResizablePersistenceName: name, persistentComputerName: name });
      await host.writeFileToVfs("/user/notes", new TextEncoder().encode("retained browser user data"));
      await host.writeFileToVfs("/software/config", new TextEncoder().encode("my local config"));
      await host.packageMaintenance({ action: "enter" });
      await host.packageMaintenance({ action: "uploadInventory", data: await bytes(inventoryUrl) });
      await host.packageMaintenance({ action: "begin" });
      let complete = false;
      for (let step = 0; step < 1000; step++) {
        if ((await host.packageMaintenance({ action: "verifyInstalled", index: 65536 })).status === 1) { complete = true; break; }
      }
      if (!complete) throw new Error("Initial package verification did not complete");
      await host.packageMaintenance({ action: "prepare" });
      return name;
    } finally { await host.destroy(); }
  }, { moduleUrl, kernelUrl, imageUrl, inventoryUrl });
  await page.reload();
  const result = await page.evaluate(async ({ moduleUrl, clientUrl, kernelUrl, imageUrl, inventoryUrl, bodyBase, name }) => {
    const { BrowserKernel } = await import(moduleUrl);
    const { PackageUpgradeClient } = await import(clientUrl);
    const bytes = async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Fixture download failed: ${url}`);
      return new Uint8Array(await response.arrayBuffer());
    };
    const boot = async () => {
      const host = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024 });
      try {
        await host.initFromImage({ kernelWasm: (await bytes(kernelUrl)).buffer, vfsImage: await bytes(imageUrl),
          experimentalResizablePersistenceName: name, persistentComputerName: name, requireExistingRootfsPersistence: true });
        return host;
      } catch (error) { await host.destroy(); throw error; }
    };
    let host = await boot();
    const text = async (path: string) => {
      const value = await host.readFileFromVfs(path);
      return value === null ? null : new TextDecoder().decode(value);
    };
    try {
      await host.packageMaintenance({ action: "enter" });
      const pending = (await host.packageMaintenance({ action: "recovery" })).status;
      const inventory = await bytes(inventoryUrl);
      const client = () => new PackageUpgradeClient((request: Parameters<typeof host.packageMaintenance>[0]) => host.packageMaintenance(request));
      await client().run("resume", {
        inventoryBytes: inventory.length,
        readInventory: async (offset: number, length: number) => inventory.slice(offset, offset + length),
        readFile: (path: string, offset: number, length: number) => bytes(`${bodyBase}?path=${encodeURIComponent(path)}&offset=${offset}&length=${length}`),
      });
      await host.packageMaintenance({ action: "leave" });
      const liveLazyContents = await text("/software/lazy");
      await host.writeFileToVfs("/software/new/sub/user", new TextEncoder().encode("new browser user child"));
      await host.destroy();
      host = await boot();
      const updated = await text("/software/tool");
      const active = await host.readFileFromVfs("/var/lib/kandelo/packages/installed");
      const expected = await bytes(inventoryUrl);
      const activeInventoryMatches = active !== null && active.length === expected.length && active.every((value: number, index: number) => value === expected[index]);
      const removed = await text("/software/remove");
      const lazyContents = await text("/software/lazy");
      await host.packageMaintenance({ action: "enter" });
      await client().run("rollback");
      await host.packageMaintenance({ action: "leave" });
      await host.destroy();
      host = await boot();
      return { pending, updated, activeInventoryMatches, removed, lazyContents, liveLazyContents,
        restored: await text("/software/tool"), oldFile: await text("/software/remove"),
        localConfig: await text("/software/config"), userData: await text("/user/notes"),
        newUserChild: await text("/software/new/sub/user") };
    } finally { await host.destroy(); }
  }, { moduleUrl, clientUrl, kernelUrl, imageUrl, inventoryUrl, bodyBase, name });
  expect(result.pending).toBe(wire.RECOVERY_PENDING);
  expect(result.updated).toBe("new program\n".repeat(7000));
  expect(result.activeInventoryMatches).toBe(true);
  expect(result.removed).toBeNull();
  expect(result.lazyContents).toBe("lazy package 2");
  expect(result.liveLazyContents).toBe("lazy package 2");
  expect(result.restored).toBe("old program");
  expect(result.oldFile).toBe("old package file");
  expect(result.localConfig).toBe("my local config");
  expect(result.userData).toBe("retained browser user data");
  expect(result.newUserChild).toBe("new browser user child");
  expect(unexpectedFetches).toEqual([]);
  expect(lazyFetches.length).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});
