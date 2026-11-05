import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { test } from "./support/persistent-page";
import { softwareImage } from "../../../host/test/fixtures/package-upgrade-image";
import { resolveBinary } from "../../../host/src/binary-resolver";

// A package update can legitimately change the machine's boot configuration.
// This drives the real kernel and OPFS through update, reopen and rollback with
// changed settings, including a refused third update. Guest edits stay refused.
test("boot configuration survives a refused update and rollback to an earlier update", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const targetDirectory = new URL(`/vfs-groups/${"2".repeat(64)}/`, baseURL).href;
  const thirdDirectory = new URL(`/vfs-groups/${"3".repeat(64)}/`, baseURL).href;
  const fourthDirectory = new URL(`/vfs-groups/${"4".repeat(64)}/`, baseURL).href;
  const before = await softwareImage(1, baseURL, { imageOwnedReference: true, bootConfiguration: true });
  const after = await softwareImage(2, baseURL, { imageOwnedReference: true, pinDirectory: targetDirectory, bootConfiguration: true });
  const third = await softwareImage(3, baseURL, { imageOwnedReference: true, pinDirectory: thirdDirectory, bootConfiguration: true });
  const fourth = await softwareImage(4, baseURL, { imageOwnedReference: true, pinDirectory: fourthDirectory, bootConfiguration: true });
  const kernel = readFileSync(resolveBinary("kernel.wasm"));
  const root = resolve(import.meta.dirname, "../../..");
  const module = (path: string) => new URL(`/@fs/${root}/${path}`, baseURL).href;
  const host = "apps/browser-demos/pages/kandelo/kernel-host";
  const urls = {
    kernelModule: module("host/src/browser-kernel-host.ts"),
    storage: module("host/src/browser-computer-storage.ts"),
    session: module(`${host}/package-maintenance-session.ts`),
    source: module(`${host}/package-image-source.ts`),
    staging: module(`${host}/opfs-source-image.ts`),
    boot: module("apps/browser-demos/lib/kernel-owned-boot.ts"),
    configuration: module(`${host}/package-boot-configuration.ts`),
    bootMetadata: module(`${host}/persistent-image-boot-metadata.ts`),
    kernel: new URL("/boot-configuration-kernel.wasm", baseURL).href,
    base: new URL("/boot-configuration-base.vfs", baseURL).href,
    target: new URL("/boot-configuration-target.vfs", baseURL).href,
    third: new URL("/boot-configuration-third.vfs", baseURL).href,
    fourth: new URL("/boot-configuration-fourth.vfs", baseURL).href,
  };
  await page.route(urls.kernel, route => route.fulfill({ body: kernel }));
  await page.route(urls.base, route => route.fulfill({ body: Buffer.from(before.bytes) }));
  await page.route(urls.target, route => route.fulfill({ body: Buffer.from(after.bytes) }));
  await page.route(urls.third, route => route.fulfill({ body: Buffer.from(third.bytes) }));
  await page.route(urls.fourth, route => route.fulfill({ body: Buffer.from(fourth.bytes) }));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const result = await page.evaluate(async ({ urls, targetDirectory, thirdDirectory, fourthDirectory }) => {
    const { BrowserKernel } = await import(urls.kernelModule);
    const { PackageMaintenanceSession } = await import(urls.session);
    const { BrowserPackageImageSource } = await import(urls.source);
    const { stageRawVfsSourceImage } = await import(urls.staging);
    const { loadPositionedImageWriterModuleBytes } = await import(urls.boot);
    const { readBootConfigurations, prepareBootConfiguration, selectBootComposition } = await import(urls.configuration);
    const { assertPersistentImageBootMetadata } = await import(urls.bootMetadata);
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
      const install = async (url: string) => {
        const session = await PackageMaintenanceSession.open(kernel, () => {});
        const staged = await stageRawVfsSourceImage(await fetch(url), () => {});
        try {
          const source = await BrowserPackageImageSource.open(await loadPositionedImageWriterModuleBytes(), staged.file,
            { length: staged.integrity.length, sha256: staged.integrity.imageSha256, directory: url === urls.third ? thirdDirectory : url === urls.fourth ? fourthDirectory : targetDirectory });
          await session.run("install", async () => ({
            source,
            prepare: async () => {
              const publish = await prepareBootConfiguration(computerId, kernel, base, source);
              return async () => {
                await publish();
                // Crash cut: records are published before the native commit.
                if (url === urls.target) titles.push(title(await authorized(kernel)));
              };
            },
            close: () => source.close(),
          }));
          await session.release();
        } finally { await session.close(); await staged.remove(); }
      };
      await install(urls.target);
      await kernel.destroy();
      kernel = await boot(true);
      const upgraded = await authorized(kernel);
      titles.push(title(upgraded));
      const services = [...upgraded.requiredServices].sort();

      const original = await kernel.readFileFromVfs("/etc/kandelo/demo.json");
      await kernel.writeFileToVfs("/etc/kandelo/demo.json", new TextEncoder().encode(JSON.stringify({ ...upgraded.imageConfig, image: { title: "guest edit" } })));
      const tampered = await authorized(kernel).then(() => "accepted", error => String(error));
      await kernel.writeFileToVfs("/etc/kandelo/demo.json", original);

      await install(urls.third);
      await kernel.destroy();
      kernel = await boot(true);
      titles.push(title(await authorized(kernel)));
      // Only release four adds this path. Its collision refuses that update
      // without preventing the native rollback from release three to two.
      await kernel.writeFileToVfs("/software/release-four", new TextEncoder().encode("user file"));
      const refused = await install(urls.fourth).then(() => "accepted", error => String(error));
      await kernel.destroy();
      kernel = await boot(true);
      titles.push(title(await authorized(kernel)));
      const rollback = await PackageMaintenanceSession.open(kernel, () => {});
      const recoveryAfterRefusal = rollback.getSnapshot().recovery;
      await rollback.run("rollback");
      await rollback.release();
      await rollback.close();
      await kernel.destroy();
      kernel = await boot(true);
      titles.push(title(await authorized(kernel)));
      return { titles, services, tampered, refused, recoveryAfterRefusal, collision: new TextDecoder().decode(await kernel.readFileFromVfs("/software/release-four")), notes: new TextDecoder().decode((await kernel.readFileFromVfs("/user/notes"))!) };
    } finally { await kernel.destroy(); }
  }, { urls, targetDirectory, thirdDirectory, fourthDirectory });
  expect(result.titles).toEqual(["Release 1", "Release 1", "Release 2", "Release 3", "Release 3", "Release 2"]);
  expect(result.services).toEqual(["db", "web"]);
  expect(result.tampered).toContain("boot configuration changed");
  expect(result.refused).toContain("maintenance refused");
  expect(result.recoveryAfterRefusal).toBe("active");
  expect(result.collision).toBe("user file");
  expect(result.notes).toBe("retained");
});
