import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildKifsGuestFixture, capacityProgram, kifsGuestPath, kifsGuestSuccess } from "../../../host/test/fixtures/kifs-v3-guest";
import { readSavedShellPrograms, shellWorkloadCount, stagePartialShell, writeCheckedPartialShell } from "../../../host/test/fixtures/kifs-v3-shell";
import { requireSavedShellSpeedTarget } from "../../../host/test/fixtures/kifs-saved-shell-workload";
import { DEV_LAZY_ASSET_ROUTE } from "../lib/init/dev-lazy-asset-route";
import { expect } from "../playwright-test";
import { opfsTest as test } from "./support/opfs-page";

const repository = resolve(import.meta.dirname, "../../..");

test("preserves guest file and directory identities across namespace changes and restart on a KIFS v3 OPFS volume", async ({ page, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const directory = mkdtempSync(join(tmpdir(), "kandelo-kifs-v3-opfs-"));
  try {
    const fixture = buildKifsGuestFixture(directory);
    const inputs = readSavedShellPrograms(capacityProgram);
    const imageUrl = new URL("/kifs-v3-guest.kifs", baseURL).href;
    const capacityUrl = new URL("/kifs-capacity.wasm", baseURL).href;
    await page.route(capacityUrl, route => route.fulfill({ body: inputs.guest }));
    const kernelUrl = new URL("/kifs-v3-guest-kernel.wasm", baseURL).href;
    const adapterUrl = new URL("/@fs/" + join(repository, "host/src/browser-kernel-host.ts"), baseURL).href;
    await page.route(imageUrl, (route) => route.fulfill({ body: fixture.image }));
    await page.route(kernelUrl, (route) => route.fulfill({ body: inputs.kernel }));
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const result = await page.evaluate(async ({ imageUrl, kernelUrl, capacityUrl, adapterUrl, identity, program, assets }) => {
      const { BrowserKernel } = await import(adapterUrl);
      const root = await navigator.storage.getDirectory();
      const name = `kifs-v3-guest-${crypto.randomUUID()}`;
      const file = await root.getFileHandle(name, { create: true });
      const writer = await file.createWritable();
      await writer.write(await (await fetch(imageUrl)).arrayBuffer());
      await writer.close();
      const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
      const snapshot = await root.getFileHandle(name + "-snapshot", { create: true });
      const boot = async (volume: FileSystemFileHandle, ...args: string[]) => {
        const decoder = new TextDecoder();
        let output = "";
        const kernel = new BrowserKernel({
          kernelOwnedFs: true,
          memoryProfile: "constrained",
          onStdout: (bytes: Uint8Array) => { output += decoder.decode(bytes); },
          onStderr: (bytes: Uint8Array) => { output += decoder.decode(bytes); },
        });
        try {
          await kernel.initFromOpfsImage({ kernelWasm, vfsImageFile: volume, experimentalKifsV3Identity: identity,
            closedLazyAssets: assets.map(asset => ({ ...asset, bytes: Uint8Array.from(asset.bytes) })) });
          if (args[0] === "snapshot") {
            const exported = await kernel.exportRootfsImageToFile(snapshot);
            const bytes = await kernel.exportRootfsImage();
            const saved = new Uint8Array(await (await snapshot.getFile()).arrayBuffer());
            if (bytes.byteLength !== exported.length || saved.byteLength !== bytes.byteLength ||
                saved.some((byte, index) => byte !== bytes[index])) throw new Error("Snapshot contents differ");
          } else {
            const status = args[0] === "fill"
              ? await kernel.spawn(await (await fetch(capacityUrl)).arrayBuffer(), ["kifs-capacity", "fill", "/opt"], { uid: 0, gid: 0 })
              : await (await kernel.spawnFromVfs(program, [program, ...args], { uid: 0, gid: 0 })).exit;
            if (status !== 0) throw new Error(`Guest exited with ${status}: ${output}`);
          }
        } finally {
          await kernel.destroy();
        }
        const shutdown = kernel.getPersistenceShutdownFailure();
        if (shutdown !== null) throw new Error(shutdown);
        return output.trim();
      };
      try {
        const fill = await boot(file, "fill");
        const created = await boot(file, "create");
        const inode = created.match(/^KIFS v3 guest persisted inode ([0-9]+)$/m)?.[1];
        if (inode === undefined) throw new Error(`Missing guest inode from create run: ${created}`);
        await boot(file, "snapshot");
        return { fill, created, inode, copy: await boot(snapshot, "verify", inode), reopened: await boot(file, "verify", inode) };
      } finally {
        await root.removeEntry(name + "-snapshot");
        await root.removeEntry(name);
      }
    }, { imageUrl, kernelUrl, capacityUrl, adapterUrl, identity: fixture.identity, program: kifsGuestPath,
      assets: fixture.assets.map(asset => ({ ...asset, bytes: Array.from(asset.bytes) })) });
    expect(result.fill).toContain("capacity exhaustion passed");
    expect(result.created).toContain(kifsGuestSuccess);
    expect(result.created).toContain("KIFS v3 guest directory descriptors passed");
    expect(result.copy).toBe(result.reopened);
    expect(result.reopened).toBe(`KIFS v3 guest verified attributes of linked inode ${result.inode}`);
    await testInfo.attach("KIFS v3 OPFS guest", {
      body: JSON.stringify({ imageSha256: fixture.sha256, imageBytes: fixture.image.length, inode: result.inode }),
      contentType: "application/json",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("creates small files on a 1 GiB staged package shell and reopens it", async ({ page, baseURL }, testInfo) => {
  const count = shellWorkloadCount();
  test.skip(count === undefined, "Set KANDELO_KIFS_SHELL_ENTRIES and build the partial shell to run the storage workload");
  test.setTimeout(40 * 60_000);
  const directory = mkdtempSync(join(tmpdir(), "kandelo-kifs-shell-"));
  try {
    const fixture = stagePartialShell(directory);
    const inputs = readSavedShellPrograms(capacityProgram);
    const image = readFileSync(fixture.path);
    const url = (path: string) => new URL(path, baseURL).href;
    await page.route(url("/staged-shell.kifs"), route => route.fulfill({ body: image }));
    await page.route(url("/capacity.wasm"), route => route.fulfill({ body: inputs.guest }));
    await page.route(url("/capacity-kernel.wasm"), route => route.fulfill({ body: inputs.kernel }));
    await page.goto(url("/trap-signal-test.html"));
    const result = await page.evaluate(async ({ adapterUrl, identity, count }) => {
      const { BrowserKernel } = await import(adapterUrl);
      const root = await navigator.storage.getDirectory();
      const name = `kifs-shell-${crypto.randomUUID()}`;
      const file = await root.getFileHandle(name, { create: true });
      const snapshot = await root.getFileHandle(name + "-snapshot", { create: true });
      try {
        await (await fetch("/staged-shell.kifs")).body!.pipeTo(await file.createWritable());
        const kernelWasm = await (await fetch("/capacity-kernel.wasm")).arrayBuffer();
        const program = await (await fetch("/capacity.wasm")).arrayBuffer();
        const rounds = [];
        let checkpoint;
        for (const round of ["create", "restart", "snapshot"]) {
          const initial = round === "create";
          const volume = round === "snapshot" ? snapshot : file;
          let output = "";
          const decoder = new TextDecoder();
          const write = (bytes: Uint8Array) => { output += decoder.decode(bytes); };
          const host = new BrowserKernel({ kernelOwnedFs: true, memoryProfile: "constrained", onStdout: write, onStderr: write });
          try {
            const start = performance.now();
            await host.initFromOpfsImage({ kernelWasm, vfsImageFile: volume, experimentalKifsV3Identity: identity });
            const bootMs = performance.now() - start;
            const bootPages = await host.getKernelMemoryPages();
            if (round === "restart") {
              const started = performance.now();
              const exported = await host.exportRootfsImageToFile(snapshot);
              checkpoint = { bytes: exported.length, imageSha256: exported.imageSha256,
                compactMs: performance.now() - started, pages: await host.getKernelMemoryPages() };
            }
            const running = performance.now();
            const last = `/home/capacity-test/entry-${String(count - 1).padStart(8, "0")}`;
            const status = initial
              ? await host.spawn(program, ["kifs-capacity", "entries", "/home", String(count)], { uid: 0, gid: 0 })
              : await (await host.spawnFromVfs("/bin/bash", ["bash", "--noprofile", "--norc", "-c",
                'test -s "$1" && test -s /home/capacity-test/entry-00000000 && echo restart-passed', "bash", last])).exit;
            if (status !== 0) throw new Error(`Guest exited ${status}: ${output}`);
            rounds.push({ round, output, bootMs, bootPages, workloadMs: performance.now() - running,
              finalPages: await host.getKernelMemoryPages(), transportMemory: await host.getStorageMetadataMemoryUsage() });
          } finally {
            await host.destroy();
          }
          const failure = host.getPersistenceShutdownFailure();
          if (failure !== null) throw new Error(failure);
        }
        return { rounds, checkpoint, fileBytes: (await file.getFile()).size };
      } finally {
        await root.removeEntry(name + "-snapshot");
        await root.removeEntry(name);
      }
    }, { adapterUrl: url("/@fs/" + join(repository, "host/src/browser-kernel-host.ts")), identity: fixture.identity, count: count! });
    expect(result.rounds[0]!.output).toContain(`capacity entries=${count} `);
    expect(result.rounds[1]!.output).toContain("restart-passed");
    expect(result.rounds[2]!.output).toContain("restart-passed");
    console.info("KIFS shell capacity " + JSON.stringify({ source: fixture.identity, startingBytes: image.length, ...result }));
    await testInfo.attach("KIFS shell capacity", {
      body: JSON.stringify({ source: fixture.identity, startingBytes: image.length, ...result }), contentType: "application/json",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compares a saved package shell before and after shared KIFS upgrade", async ({ page, baseURL }, testInfo) => {
  test.skip(process.env.KANDELO_KIFS_COMPARE !== "1", "opt-in package I/O comparison");
  const warmStat = process.env.KANDELO_KIFS_WARM_STAT === "1";
  const requireSpeed = process.env.KANDELO_KIFS_REQUIRE_SPEED_TARGET === "1";
  if (warmStat && requireSpeed) throw new Error("Warm stat diagnostic cannot qualify the saved-shell speed target");
  const entries = shellWorkloadCount();
  test.setTimeout(entries === undefined ? 900_000 : 3_600_000);
  const directory = mkdtempSync(join(tmpdir(), "kifs-saved-shell-"));
  try {
    const checked = await writeCheckedPartialShell(directory);
    const inputs = readSavedShellPrograms(capacityProgram);
    const url = (path: string) => new URL(path, baseURL).href;
    await page.route(url("/checked-shell.img"), route => route.fulfill({ body: readFileSync(checked.path) }));
    await page.route(url("/capacity.wasm"), route => route.fulfill({ body: inputs.guest }));
    await page.route(url("/capacity-kernel.wasm"), route => route.fulfill({ body: inputs.kernel }));
    await page.goto(url("/trap-signal-test.html"));
    const result = await page.evaluate(async ({ identity, hostUrl, lazyAssetDirectory, workloadUrl, warmStatUrl, entries, observerUrl, measureTmpfs, profileReads, reverseOrder }) => {
      const { BrowserKernel } = await import(hostUrl);
      const { compareSavedShell, savedShellComputer } = await import(workloadUrl) as typeof import("../../../host/test/fixtures/kifs-saved-shell-workload");
      const root = await navigator.storage.getDirectory();
      const overlay = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
      const name = "shell-comparison-" + crypto.randomUUID();
      const controlName = name + "-control";
      const stateName = (phase: import("../../../host/test/fixtures/kifs-saved-shell-workload").ShellBootPhase) =>
        savedShellComputer(phase) === "control" ? controlName : name;
      const file = await root.getFileHandle(name, { create: true });
      const controlFile = warmStatUrl ? await root.getFileHandle(controlName, { create: true }) : file;
      const NativeWorker = window.Worker;
      if (observerUrl) window.Worker = class extends NativeWorker {
        constructor(url: URL | string, options?: WorkerOptions) {
          super(String(url).includes("browser-kernel-worker-entry") ? observerUrl! : url, options);
        }
      };
      try {
        await (await fetch("/checked-shell.img")).body!.pipeTo(await file.createWritable());
        if (warmStatUrl) await (await fetch("/checked-shell.img")).body!.pipeTo(await controlFile.createWritable());
        const kernelWasm = await (await fetch("/capacity-kernel.wasm")).arrayBuffer();
        const program = await (await fetch("/capacity.wasm")).arrayBuffer();
        const boot = async (phase: import("../../../host/test/fixtures/kifs-saved-shell-workload").ShellBootPhase, write: (bytes: Uint8Array) => void) => {
          const computerName = stateName(phase);
          const seeding = phase === "seed" || phase === "seed-control";
          const host = new BrowserKernel({ kernelOwnedFs: true, memoryProfile: "constrained", onStdout: write, onStderr: write });
          try {
            await host.initFromOpfsImage({ kernelWasm, lazyAssetDirectory, vfsImageFile: computerName === controlName ? controlFile : file, experimentalResizablePersistenceName: computerName,
              persistentComputerName: computerName, requireExistingRootfsPersistence: !seeding,
              kifsUpgradeProfile: phase === "upgrade" ? "development" : seeding || phase === "legacy" ? "legacy" : undefined,
              persistentImageBinding: { identitySha256: identity, dataCachePages: 1, indexCachePages: 1 } });
            return host;
          } catch (error) { await host.destroy(); throw error; }
        };
        if (warmStatUrl) {
          const { compareWarmSavedStat } = await import(warmStatUrl) as typeof import("../../../host/test/fixtures/kifs-warm-stat-workload");
          return { warmStat: await compareWarmSavedStat(program, boot, reverseOrder, observerUrl ? stateName : undefined) };
        }
        const rounds = await compareSavedShell(program, boot, async phase => {
          let total = 0;
          for await (const filename of overlay.keys()) {
            if (filename.startsWith(stateName(phase) + ".")) total += (await (await overlay.getFileHandle(filename)).getFile()).size;
          }
          return total;
        }, entries, undefined, observerUrl ? stateName : undefined, measureTmpfs, profileReads, reverseOrder);
        return { rounds };
      } finally {
        window.Worker = NativeWorker;
        for await (const filename of overlay.keys()) {
          if (filename.startsWith(name + ".") || filename.startsWith(controlName + ".")) await overlay.removeEntry(filename);
        }
        await root.removeEntry(name);
        if (warmStatUrl) await root.removeEntry(controlName);
      }
    }, { identity: checked.identity, entries, reverseOrder: process.env.KANDELO_KIFS_V3_FIRST === "1", profileReads: process.env.KANDELO_KIFS_PROFILE_READS === "1", measureTmpfs: process.env.KANDELO_KIFS_TMPFS_CONTROL === "1",
      observerUrl: process.env.KANDELO_KIFS_IO_PROFILE === "1" ? url("/@fs/" + resolve(import.meta.dirname, "fixtures/kifs-io-profile-worker.ts") + "?worker_file&type=module") : undefined,
      hostUrl: url("/@fs/" + resolve(import.meta.dirname, "../../../host/src/browser-kernel-host.ts")),
      lazyAssetDirectory: url(DEV_LAZY_ASSET_ROUTE),
      workloadUrl: url("/@fs/" + resolve(import.meta.dirname, "../../../host/test/fixtures/kifs-saved-shell-workload.ts")),
      warmStatUrl: warmStat
        ? url("/@fs/" + resolve(import.meta.dirname, "../../../host/test/fixtures/kifs-warm-stat-workload.ts")) : undefined,
    });
    if (result.warmStat) {
      const evidence = { source: checked.source, ...inputs.digests, ...result.warmStat };
      console.info("KIFS warm saved stat " + JSON.stringify(evidence));
      await testInfo.attach("KIFS warm saved stat", { body: JSON.stringify(evidence), contentType: "application/json" });
      return;
    }
    const rounds = result.rounds;
    console.info("KIFS saved shell IO " + JSON.stringify({ source: checked.source, ...inputs.digests, rounds }));
    await testInfo.attach("KIFS saved shell IO", { body: JSON.stringify({ source: checked.source, ...inputs.digests, rounds }), contentType: "application/json" });
    if (requireSpeed) requireSavedShellSpeedTarget(rounds);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
