import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { opfsTest as test } from "./support/opfs-page";
import { routeCurrentImageModules } from "./support/current-image-module";

const repository = resolve(import.meta.dirname, "../../..");
const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(resolve(repository, "local-binaries/kandelo_image_module32.wasm"))));
filesystem.mkdir("/etc", 0o755);
filesystem.mkdir("/etc/kandelo", 0o755);
filesystem.mkdir("/bin", 0o755);
filesystem.writeFile("/bin/probe", Uint8Array.of(0), 0o755);
filesystem.writeFile("/state", new TextEncoder().encode("original"), 0o640);
filesystem.writeFile("/large", new Uint8Array(512 * 1024).fill(73), 0o600);
filesystem.writeFile("/etc/kandelo/demo.json", new TextEncoder().encode(JSON.stringify({
  version: 1, defaultProfile: "probe", profiles: { probe: {
    identity: { title: "Saved image", summary: "Persistent checked image", accent: "#123456", glyph: "sh" },
  } },
})), 0o644);
filesystem.writeFile("/etc/kandelo/experimental-terminal-session.json", new TextEncoder().encode(JSON.stringify({
  kind: "kandelo-experimental-terminal-session", version: 1,
  initial: { path: "/bin/probe", argv: ["probe"], uid: 0, gid: 0 },
})), 0o644);
const rawImage = filesystem.exportImage();
filesystem.reset();

for (const policy of ["crc32c", "sha256"] as const) {
  test(`saved ${policy} computer composes, journals, checkpoints and reopens without reading the whole base`, async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const imageUrl = new URL("/saved-image.vfs", baseURL).href;
    const kernelUrl = new URL("/saved-image-kernel.wasm", baseURL).href;
    await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(rawImage) }));
    await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(resolve(repository, "target/wasm32-unknown-unknown/release/kandelo_kernel.wasm")) }));
    await routeCurrentImageModules(page.context());
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const result = await page.evaluate(async ({ composerUrl, persistenceUrl, checkpointUrl, browserKernelUrl, imageUrl, kernelUrl, policy }) => {
      const { composeImageInWorker } = await import(composerUrl) as typeof import("../pages/kandelo/kernel-host/image-composer-client");
      const api = await import(persistenceUrl) as typeof import("../pages/kandelo/kernel-host/fixed-persistence-image");
      const { checkpointPersistentImage } = await import(checkpointUrl) as typeof import("../pages/kandelo/kernel-host/persistent-image-checkpoint");
      const { BrowserKernel } = await import(browserKernelUrl) as typeof import("../../../host/src/browser-kernel-host");
      const name = `checked-saved-${crypto.randomUUID()}`;
      const identity = "checked saved image integration";
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay", { create: true });
      const kernels = new Set<InstanceType<typeof BrowserKernel>>();
      const journals = new Set<string>();
      const createKernel = () => {
        const kernel = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024, maxMemoryPages: 1024, memoryProfile: "constrained" });
        kernels.add(kernel);
        return kernel;
      };
      try {
        const composed = await composeImageInWorker({
          imageBytes: new Uint8Array(await (await fetch(imageUrl)).arrayBuffer()),
          persistentImage: { name, identity, integrityPolicy: policy },
          maxVfsByteLength: 64 * 1024 * 1024,
          imageLabel: "saved image", requestedProfileId: "probe", requestedProfileSource: "test",
          hasCandidateEvidence: false, descriptor: { boot: { inputs: [] } } as never,
          appPath: "/pages/kandelo/", proto: "http", preforkServiceProcesses: 1,
        }, { onTick: () => {}, isCurrent: () => true, supersededError: () => new Error("superseded") });
        const installed = composed.imageFile;
        if (installed === undefined) throw new Error("composer did not publish a saved image");
        journals.add(installed.journalName);
        const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
        const boot = async (image: typeof installed, existing: boolean) => {
          const kernel = createKernel();
          await kernel.initFromOpfsImage({ kernelWasm, vfsImageFile: image.file,
            persistentImageBinding: image.persistentImageBinding,
            persistentComputerName: name, experimentalResizablePersistenceName: image.journalName,
            requireExistingRootfsPersistence: existing });
          return kernel;
        };
        const first = await boot(installed, false);
        await first.writeFileToVfs("/new-file", new TextEncoder().encode("journal survived checkpoint"), 0o640);
        await first.destroy();
        kernels.delete(first);
        await api.markFixedPersistenceJournalInitialized(name, identity, installed);
        let wrongPolicyRejected = false;
        try {
          const replacement = new Uint8Array(await (await fetch(imageUrl)).arrayBuffer());
          await api.stageFixedPersistenceReplacement(name, identity, {
            chunks: [replacement], payloadLength: replacement.length,
            integrityPolicy: policy === "crc32c" ? "sha256" : "crc32c",
          }, installed.lazyAssets, installed.composition);
        } catch (error) { wrongPolicyRejected = /checking policy/.test(String(error)); }
        const { staged } = await checkpointPersistentImage({
          name, mode: "resizable", identity, journalName: installed.journalName, kernelWasm,
          createKernel, closeKernel: async kernel => { await kernel.destroy(); kernels.delete(kernel); },
          lazyUrlMapForImage: () => ({}), releaseLease: async () => {},
          validateCandidate: async kernel => {
            const bytes = await kernel.readFileFromVfs("/new-file");
            if (new TextDecoder().decode(bytes!) !== "journal survived checkpoint") throw new Error("checkpoint lost data");
          },
        });
        journals.add(staged.journalName);
        const filePrototype = Object.getPrototypeOf(await staged.file.getFile());
        const originalSlice = filePrototype.slice;
        const ranges: Array<[number, number]> = [];
        filePrototype.slice = function (this: File, start?: number, end?: number, contentType?: string) {
          if (this.name === staged.file.name) ranges.push([start ?? 0, end ?? this.size]);
          return originalSlice.call(this, start, end, contentType);
        };
        let restored;
        try { restored = await api.loadFixedPersistenceImageHandle(name, identity); }
        finally { filePrototype.slice = originalSlice; }
        if (restored === null) throw new Error("saved computer disappeared");
        const reopened = await boot(restored, true);
        const content = new TextDecoder().decode((await reopened.readFileFromVfs("/new-file"))!);
        const manifest = JSON.parse(await (await (await directory.getFileHandle(name + ".base.json")).getFile()).text());
        await reopened.destroy();
        kernels.delete(reopened);
        return { content, wrongPolicyRejected, ranges, policy: restored.integrityPolicy,
          manifestPolicy: manifest.integrityPolicy, format: manifest.imageFormat, version: manifest.format,
          generation: restored.generation, changedJournal: installed.journalName !== restored.journalName,
          length: restored.length, payloadLength: restored.payloadLength,
          emptyComposedBytes: composed.imageBytes.length === 0 };
      } finally {
        await Promise.allSettled([...kernels].map(kernel => kernel.destroy()));
        for await (const filename of directory.keys()) {
          if (filename.startsWith(name + ".") || [...journals].some(journal => filename.startsWith(journal + "."))) {
            await directory.removeEntry(filename, { recursive: true });
          }
        }
      }
    }, {
      composerUrl: new URL(`/@fs/${resolve(repository, "apps/browser-demos/pages/kandelo/kernel-host/image-composer-client.ts")}`, baseURL).href,
      persistenceUrl: new URL(`/@fs/${resolve(repository, "apps/browser-demos/pages/kandelo/kernel-host/fixed-persistence-image.ts")}`, baseURL).href,
      checkpointUrl: new URL(`/@fs/${resolve(repository, "apps/browser-demos/pages/kandelo/kernel-host/persistent-image-checkpoint.ts")}`, baseURL).href,
      browserKernelUrl: new URL(`/@fs/${resolve(repository, "host/src/browser-kernel-host.ts")}`, baseURL).href,
      imageUrl, kernelUrl, policy,
    });
    expect(result.content).toBe("journal survived checkpoint");
    expect(result.wrongPolicyRejected).toBe(true);
    expect(result.policy).toBe(policy);
    expect(result.manifestPolicy).toBe(policy);
    expect(result.format).toBe("kandelo-checked-image-v1");
    expect(result.version).toBe("kandelo-fixed-rootfs-image-v6");
    expect(result.generation).toBe(1);
    expect(result.changedJournal).toBe(true);
    expect(result.length).toBeGreaterThan(result.payloadLength);
    expect(result.emptyComposedBytes).toBe(true);
    expect(result.ranges.length).toBeGreaterThan(0);
    expect(result.ranges.every(([start, end]) => start === 0 && end <= 4096)).toBe(true);
  });
}
