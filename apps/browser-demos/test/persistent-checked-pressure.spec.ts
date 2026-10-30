import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "@playwright/test";
import { checkedPressureImage, servePressureImage, PRESSURE_COLD_BYTES, PRESSURE_SAMPLE_OFFSETS,
  PRESSURE_SEED_FILES, pressureSeedPath, pressureColdByte, retainPressureFixture } from "../../../host/test/fixtures/checked-pressure-image";
import { opfsTest as test } from "./support/opfs-page";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { parseFilesystemMemory, validateFilesystemMemoryBounds } from "../../../host/test/fixtures/filesystem-memory";

const repository = resolve(import.meta.dirname, "../../..");

for (const policy of ["crc32c", "sha256"] as const) {
  test(`${policy} OPFS checked-base aggregate pressure survives strict reopen and streamed snapshot recovery`, async ({ page, baseURL }, testInfo) => {
    test.setTimeout(600_000);
    const temporary = mkdtempSync(join(tmpdir(), "kandelo-opfs-checked-pressure-"));
    let server: Awaited<ReturnType<typeof servePressureImage>> | undefined;
    let retainStorage = false;
    const progress: Array<{ elapsedMs: number; stage: string }> = [];
    const started = performance.now();
    page.on("console", message => {
      const stage = message.text();
      if (!stage.startsWith("[checked-pressure]")) return;
      if (progress.length === 64) progress.shift();
      progress.push({ elapsedMs: performance.now() - started, stage });
      console.info(stage);
    });
    try {
      const fixture = await checkedPressureImage(temporary, policy);
      server = await servePressureImage(fixture.path);
      const kernelUrl = new URL("/checked-pressure-kernel.wasm", baseURL).href;
      const codecWasmUrl = new URL("/checked-pressure-codec.wasm", baseURL).href;
      await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(resolveBinary("kernel.wasm")) }));
      await page.route(codecWasmUrl, route => route.fulfill({ body: readFileSync(join(repository,
        "local-binaries/kandelo_image_module_positioned32.wasm")) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async parameters => {
        const mark = (stage: string) => console.info(`[checked-pressure] ${parameters.policy} ${stage}`);
        const NativeWorker = globalThis.Worker;
        const workers: Worker[] = [];
        const codecs: Worker[] = [];
        const terminated = new WeakSet<Worker>();
        globalThis.Worker = class extends NativeWorker {
          constructor(url: string | URL, options?: WorkerOptions) {
            const kernel = String(url).includes("browser-kernel-worker-entry");
            super(kernel ? parameters.measuredWorkerUrl : url, options);
            if (kernel) workers.push(this);
            if (String(url).includes("persistent-image-codec-worker")) codecs.push(this);
          }
          override terminate(): void { terminated.add(this); super.terminate(); }
        };
        const storageStats = async (stage: string) => {
          const worker = workers.at(-1);
          if (worker === undefined) throw new Error("Pressure kernel worker was not instrumented");
          const channel = new MessageChannel();
          const statistics = await new Promise<Array<[string, { bytes: number; calls: number; maxRequest: number }]>>((resolve, reject) => {
            const timer = setTimeout(() => { channel.port1.close(); reject(new Error("Pressure storage probe did not respond")); }, 10_000);
            channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
            worker.postMessage({ type: "kandelo-test-storage-stats" }, [channel.port2]);
          });
          mark(`${stage}:storage:${JSON.stringify(statistics)}`);
          return { stage, statistics };
        };
        const { BrowserKernel } = await import(parameters.kernelModule) as typeof import("../../../host/src/browser-kernel-host");
        const { writePersistentImageFile, UnprovenImageCodecCleanupError } = await import(parameters.codecModule) as typeof import("../pages/kandelo/kernel-host/persistent-image-codec");
        const root = await navigator.storage.getDirectory();
        const name = `checked-pressure-${crypto.randomUUID()}`;
        const directory = await root.getDirectoryHandle(name, { create: true });
        const base = await directory.getFileHandle("base", { create: true });
        let active: InstanceType<typeof BrowserKernel> | undefined;
        let clean = true;
        let codecClean = true;
        let inputClosed = false;
        const phases: Array<{ phase: string; code: number; output: string; pages: number; elapsedMs: number }> = [];
        const storage = [];
        const memory: Array<{ phase: string; stage: string; report: string; host: { used: number; peak: number; limit: number }; pages: number }> = [];
        const codecMemory: Array<{ wasmPages: number; inputWindowPeak: number; callerInputChunkPeak: number; callerInputBackingPeak: number }> = [];
        try {
          mark("download:start");
          const response = await fetch(parameters.imageUrl);
          if (!response.ok || response.body === null) throw new Error("Checked pressure base download failed");
          await response.body.pipeTo(await base.createWritable());
          inputClosed = true;
          mark("download:closed");
          const physicalLength = (await base.getFile()).size;
          const kernelWasm = await (await fetch(parameters.kernelUrl)).arrayBuffer();
          const codecWasm = new Uint8Array(await (await fetch(parameters.codecWasmUrl)).arrayBuffer());
          const checkedSnapshot = await directory.getFileHandle("snapshot.img", { create: true });
          let snapshotBinding = parameters.binding;
          let snapshotLength = 0;
          for (const phase of ["write", "reopen", "snapshot", "snapshot-reopen"]) {
            mark(`${phase}:start`);
            const started = performance.now();
            let output = "";
            const accept = (bytes: Uint8Array) => { output = (output + new TextDecoder().decode(bytes)).slice(-16384); };
            active = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024,
              maxMemoryPages: 1024, maxWorkers: 1, memoryProfile: "constrained", onStdout: accept, onStderr: accept });
            clean = false;
            const snapshotPhase = phase.startsWith("snapshot");
            const computer = snapshotPhase ? `${name}-snapshot` : name;
            await active.initFromOpfsImage({ kernelWasm, vfsImageFile: snapshotPhase ? checkedSnapshot : base,
              persistentImageBinding: snapshotPhase ? snapshotBinding : parameters.binding,
              experimentalResizablePersistenceName: computer, persistentComputerName: computer,
              requireExistingRootfsPersistence: phase.endsWith("reopen") });
            mark(`${phase}:initialized`);
            const observeMemory = async (stage: string) => {
              const previousOutput = output;
              output = "";
              const observer = await active!.spawnFromVfs("/bin/pressure", ["pressure", "memory"]);
              const code = await observer.exit;
              if (code !== 0) throw new Error(`Memory observer failed (${code}): ${output}`);
              const report = output;
              output = previousOutput;
              memory.push({ phase, stage, report, host: await active!.getStorageMetadataMemoryUsage(),
                pages: await active!.getKernelMemoryPages() });
            };
            await observeMemory("initialized");
            const process = await active.spawnFromVfs("/bin/pressure", ["pressure", phase === "write" ? "write" : "verify"]);
            const code = await process.exit;
            mark(`${phase}:guest-exited:${code}`);
            if (code !== 0) throw new Error(`Pressure guest ${phase} failed (${code}): ${output}`);
            await observeMemory("workload-complete");
            for (const sample of parameters.samples) {
              const bytes = await active.readFileRangeFromVfs("/cold", sample.offset, sample.bytes.length);
              if (bytes?.length !== sample.bytes.length || bytes.some((byte, index) => byte !== sample.bytes[index])) {
                throw new Error(`Cold checked data changed in ${phase} at ${sample.offset}`);
              }
            }
            const entries = await active.readDirFromVfs("/seed");
            if (entries?.length !== parameters.seedNames.length) throw new Error("Seed namespace count changed");
            const names = new Set(parameters.seedNames);
            for (const entry of entries) {
              if (!names.delete(entry.name) || (entry.mode & 0o777) !== 0o640 || entry.size !== 0) throw new Error(`Seed metadata changed: ${entry.name}`);
            }
            if (names.size !== 0) throw new Error("Seed namespace entries disappeared");
            if (phase === "snapshot") await active.writeFileToVfs("/snapshot-journal-only", new TextEncoder().encode(parameters.policy), 0o600);
            if (phase === "snapshot-reopen" && new TextDecoder().decode((await active.readFileFromVfs("/snapshot-journal-only"))!) !== parameters.policy) {
              throw new Error("Snapshot's new journal was not replayed");
            }
            if ((await active.statVfsPath("/cold"))?.size !== parameters.coldBytes) throw new Error("Cold file size changed");
            if (phase === "write") {
              storage.push(await storageStats("snapshot-export:before"));
              mark("snapshot-export:start");
              const rawSnapshot = await directory.getFileHandle("snapshot.vfs", { create: true });
              await active.exportRootfsImageToFile(rawSnapshot);
              mark("snapshot-export:closed");
              await observeMemory("snapshot-export-complete");
              storage.push(await storageStats("snapshot-export:after"));
              const snapshot = await rawSnapshot.getFile();
              async function* chunks() {
                for (let offset = 0; offset < snapshot.size; offset += 65536) {
                  yield new Uint8Array(await snapshot.slice(offset, offset + 65536).arrayBuffer());
                }
              }
              let written;
              mark("snapshot-codec:start");
              try { written = await writePersistentImageFile(checkedSnapshot, codecWasm, snapshot.size, parameters.policy, chunks(), {
                onMemoryUsage: usage => {
                  const worker = codecs.at(-1);
                  if (worker === undefined || !terminated.has(worker)) throw new Error("Codec memory observed before worker retirement");
                  codecMemory.push(usage);
                },
              }); }
              catch (error) {
                if (error instanceof UnprovenImageCodecCleanupError) codecClean = false;
                throw error;
              }
              snapshotBinding = { identitySha256: written.identitySha256, dataCachePages: 2, indexCachePages: 2 };
              snapshotLength = written.physicalLength;
              mark("snapshot-codec:closed");
            }
            phases.push({ phase, code, output, pages: await active.getKernelMemoryPages(), elapsedMs: performance.now() - started });
            mark(`${phase}:destroy:start`);
            await active.destroy();
            if (active.hasUnconfirmedKernelQuiescence() || active.getPersistenceShutdownFailure() !== null) throw new Error("Pressure kernel shutdown is unproven");
            active = undefined;
            clean = true;
            mark(`${phase}:complete`);
          }
          return { physicalLength, snapshotLength, phases, storage, memory, codecMemory };
        } finally {
          globalThis.Worker = NativeWorker;
          if (active !== undefined) {
            await active.destroy();
            clean = !active.hasUnconfirmedKernelQuiescence() && active.getPersistenceShutdownFailure() === null;
          }
          if (clean && codecClean && inputClosed) {
            const overlay = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
            for await (const filename of overlay.keys()) {
              if (filename.startsWith(`${name}.`) || filename.startsWith(`${name}-snapshot.`)) {
                await overlay.removeEntry(filename, { recursive: true });
              }
            }
            await root.removeEntry(name, { recursive: true });
          }
        }
      }, { imageUrl: server.url, kernelUrl, codecWasmUrl, binding: fixture.binding, policy,
        coldBytes: PRESSURE_COLD_BYTES,
        samples: PRESSURE_SAMPLE_OFFSETS.map(offset => ({ offset,
          bytes: Array.from({ length: 257 }, (_, index) => pressureColdByte(offset + index)) })),
        seedNames: Array.from({ length: PRESSURE_SEED_FILES }, (_, index) => pressureSeedPath(index).slice(6)),
        kernelModule: new URL(`/@fs/${join(repository, "host/src/browser-kernel-host.ts")}`, baseURL).href,
        measuredWorkerUrl: new URL(`/@fs/${join(repository, "apps/browser-demos/test/fixtures/persistent-io-kernel-worker.ts")}?worker_file&type=module`, baseURL).href,
        codecModule: new URL(`/@fs/${join(repository, "apps/browser-demos/pages/kandelo/kernel-host/persistent-image-codec.ts")}`, baseURL).href });
      const memory = result.memory.map(sample => {
        const admission = parseFilesystemMemory(sample.report);
        validateFilesystemMemoryBounds(admission);
        expect(sample.pages).toBeLessThanOrEqual(1024);
        expect(sample.host.used).toBeLessThanOrEqual(sample.host.peak);
        expect(sample.host.peak).toBeLessThanOrEqual(sample.host.limit);
        return { ...sample, admission };
      });
      expect(memory).toHaveLength(9);
      expect(result.codecMemory).toHaveLength(1);
      for (const codec of result.codecMemory) {
        expect(codec.wasmPages * 65536).toBeLessThan(result.physicalLength);
        expect(codec.inputWindowPeak).toBeLessThanOrEqual(65536);
        expect(codec.callerInputChunkPeak).toBeLessThanOrEqual(65536);
        expect(codec.callerInputBackingPeak).toBeLessThanOrEqual(65536);
      }
      await testInfo.attach("checked-pressure-memory", { contentType: "application/json", body: JSON.stringify({ policy,
        kernelCeilingBytes: 64 * 1024 * 1024, seedFiles: PRESSURE_SEED_FILES, ...result, memory }) });
      expect(result.physicalLength).toBe(fixture.physicalLength);
      expect(result.physicalLength).toBeGreaterThan(PRESSURE_COLD_BYTES);
      expect(result.snapshotLength).toBeGreaterThan(PRESSURE_COLD_BYTES);
      expect(result.phases).toHaveLength(4);
      for (const phase of result.phases) {
        expect(phase.code, phase.output).toBe(0);
        expect(phase.output).toContain("AGGREGATE_PRESSURE_VERIFIED");
        expect(phase.pages).toBeLessThanOrEqual(1024);
      }
      expect(result.phases[0]!.output).toMatch(/PRESSURE_REFUSAL created=\d+ errno=12/);
    } catch (error) { retainStorage = retainPressureFixture(error); throw error; }
    finally {
      await testInfo.attach("checked-pressure-progress", { contentType: "application/json", body: JSON.stringify({ policy, progress }) });
      await server?.close();
      if (!retainStorage) rmSync(temporary, { recursive: true, force: true });
      else console.error(`Retained pressure fixture after unproven cleanup: ${temporary}`);
    }
  });
}
