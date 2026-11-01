import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { test } from "./support/persistent-page";
import { softwareImage } from "../../../host/test/fixtures/package-upgrade-image";
import { resolveBinary } from "../../../host/src/binary-resolver";

// A package update can legitimately change the machine's boot configuration.
// This drives the real kernel and OPFS through update, reopen and rollback with
// a target that does, and proves a guest edit is still refused afterwards.
test("boot configuration follows the installed software through update and rollback", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const targetDirectory = new URL(`/vfs-groups/${"2".repeat(64)}/`, baseURL).href;
  const before = await softwareImage(1, baseURL, { imageOwnedReference: true, bootConfiguration: true });
  const after = await softwareImage(2, baseURL, { imageOwnedReference: true, pinDirectory: targetDirectory, bootConfiguration: true });
  const kernel = readFileSync(resolveBinary("kernel.wasm"));
  const root = resolve(import.meta.dirname, "../../..");
  const module = (path: string) => new URL(`/@fs/${root}/${path}`, baseURL).href;
  const host = "apps/browser-demos/pages/kandelo/kernel-host";
  const urls = {
    kernelModule: module("host/src/browser-kernel-host.ts"),
    storage: module("host/src/browser-computer-storage.ts"),
    client: module(`${host}/package-upgrade-client.ts`),
    source: module(`${host}/package-image-source.ts`),
    staging: module(`${host}/opfs-source-image.ts`),
    boot: module("apps/browser-demos/lib/kernel-owned-boot.ts"),
    configuration: module(`${host}/package-boot-configuration.ts`),
    checkpoint: module(`${host}/persistent-image-checkpoint.ts`),
    kernel: new URL("/boot-configuration-kernel.wasm", baseURL).href,
    base: new URL("/boot-configuration-base.vfs", baseURL).href,
    target: new URL("/boot-configuration-target.vfs", baseURL).href,
  };
  await page.route(urls.kernel, route => route.fulfill({ body: kernel }));
  await page.route(urls.base, route => route.fulfill({ body: Buffer.from(before.bytes) }));
  await page.route(urls.target, route => route.fulfill({ body: Buffer.from(after.bytes) }));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const result = await page.evaluate(async ({ urls, targetDirectory }) => {
    const { BrowserKernel } = await import(urls.kernelModule);
    const { PackageUpgradeClient } = await import(urls.client);
    const { BrowserPackageImageSource } = await import(urls.source);
    const { stageRawVfsSourceImage } = await import(urls.staging);
    const { loadPositionedImageWriterModuleBytes } = await import(urls.boot);
    const { readBootConfigurations, recordBootConfiguration, selectBootComposition } = await import(urls.configuration);
    const { assertPersistentImageBootMetadata } = await import(urls.checkpoint);
    const name = `boot-configuration-${crypto.randomUUID()}`;
    const computerId = crypto.randomUUID();
    await (await import(urls.storage)).browserComputerDirectory(computerId, true);
    const bytes = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());
    const boot = async (existing: boolean) => {
      const kernel = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024 });
      try {
        await kernel.initFromImage({ kernelWasm: (await bytes(urls.kernel)).buffer, vfsImage: await bytes(urls.base),
          experimentalResizablePersistenceName: name, persistentComputerName: name, requireExistingRootfsPersistence: existing });
        return kernel;
      } catch (error) { await kernel.destroy(); throw error; }
    };
    const base = {
      imageConfig: { version: 1, image: { title: "Release 1" }, defaultProfile: "site", profiles: { site: { init: { target: "boot" } } } },
      profileId: "site",
      terminalSession: { kind: "kandelo-experimental-terminal-session", version: 1, initial: { path: "/bin/true", argv: ["true"], uid: 0, gid: 0 } },
      requiredServices: ["boot"],
    };
    const authorized = async (kernel: unknown) => {
      const composition = await selectBootComposition(kernel, await readBootConfigurations(computerId), base);
      await assertPersistentImageBootMetadata(kernel, composition);
      return composition;
    };
    const titles: string[] = [];
    const title = (composition: typeof base) => composition.imageConfig.image.title;
    let kernel = await boot(false);
    try {
      titles.push(title(await authorized(kernel)));
      await kernel.writeFileToVfs("/user/notes", new TextEncoder().encode("retained"));
      await kernel.packageMaintenance({ action: "enter" });
      const staged = await stageRawVfsSourceImage(await fetch(urls.target), () => {});
      try {
        const source = await BrowserPackageImageSource.open(await loadPositionedImageWriterModuleBytes(), staged.file,
          { length: staged.integrity.length, sha256: staged.integrity.imageSha256, directory: targetDirectory });
        try {
          await recordBootConfiguration(computerId, kernel, base, source);
          // Crash cut: the record is published but nothing was committed.
          titles.push(title(await selectBootComposition(kernel, await readBootConfigurations(computerId), base)));
          await new PackageUpgradeClient((request: unknown) => kernel.packageMaintenance(request)).run("install", source);
        } finally { await source.close(); }
      } finally { await staged.remove(); }
      await kernel.packageMaintenance({ action: "leave" });
      await kernel.destroy();
      kernel = await boot(true);
      const upgraded = await authorized(kernel);
      titles.push(title(upgraded));
      const services = [...upgraded.requiredServices].sort();

      const original = await kernel.readFileFromVfs("/etc/kandelo/demo.json");
      await kernel.writeFileToVfs("/etc/kandelo/demo.json", new TextEncoder().encode(JSON.stringify({ ...upgraded.imageConfig, image: { title: "guest edit" } })));
      const tampered = await authorized(kernel).then(() => "accepted", error => String(error));
      await kernel.writeFileToVfs("/etc/kandelo/demo.json", original);

      await kernel.packageMaintenance({ action: "enter" });
      await new PackageUpgradeClient((request: unknown) => kernel.packageMaintenance(request)).run("rollback");
      await kernel.packageMaintenance({ action: "leave" });
      await kernel.destroy();
      kernel = await boot(true);
      titles.push(title(await authorized(kernel)));
      return { titles, services, tampered, notes: new TextDecoder().decode((await kernel.readFileFromVfs("/user/notes"))!) };
    } finally { await kernel.destroy(); }
  }, { urls, targetDirectory });
  expect(result.titles).toEqual(["Release 1", "Release 1", "Release 2", "Release 1"]);
  expect(result.services).toEqual(["db", "web"]);
  expect(result.tampered).toContain("boot configuration changed");
  expect(result.notes).toBe("retained");
});
