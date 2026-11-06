import { BrowserKernel } from "@host/browser-kernel-host";
import kernelUrl from "@kernel-wasm?url";
import { browserComputerDirectory, browserComputerStorageName } from "@host/browser-computer-storage";
import { stageRawVfsSourceImage, type StagedSourceImage } from "../kandelo/kernel-host/opfs-source-image";

let kernel: BrowserKernel | null = null;
let sequence = 0;
let persistent: { source: StagedSourceImage; kernelWasm: ArrayBuffer; name: string } | null = null;

async function phase<Result>(name: string, operation: () => Promise<Result>): Promise<Result> {
  try { return await operation(); }
  catch (cause) { throw new Error(`Compatibility fixture ${name}: ${String(cause)}`, { cause }); }
}

async function shutdownKernel() {
  const owner = kernel;
  if (!owner) return;
  await owner.destroy();
  if (!owner.getOwnedJobLifetime().closed || owner.hasUnconfirmedKernelQuiescence()) throw new Error("Compatibility owner did not retire");
  const syncFailure = owner.getPersistenceShutdownFailure();
  if (syncFailure !== null) throw new Error(`Compatibility persistence shutdown failed: ${syncFailure}`);
  kernel = null;
}

const fixture = {
  async initialize(imageUrl: string, persistentName?: string) {
    if (kernel) throw new Error("The compatibility kernel is already initialized");
    const owner = new BrowserKernel({ memoryProfile: "constrained", maxWorkers: 4 });
    kernel = owner;
    const [moduleResponse, imageResponse] = await phase("fetch image and kernel", () => Promise.all([fetch(kernelUrl), fetch(imageUrl)]));
    if (!moduleResponse.ok || !imageResponse.ok) throw new Error("Compatibility fixture download failed");
    const kernelWasm = await moduleResponse.arrayBuffer();
    if (persistentName === undefined) {
      await owner.initFromImage({ kernelWasm, vfsImage: new Uint8Array(await imageResponse.arrayBuffer()) });
    } else {
      const directory = await phase("open computer directory", async () => (await browserComputerDirectory(persistentName)).getDirectoryHandle("filesystem", { create: true }));
      const source = await phase("stream source image", () => stageRawVfsSourceImage(imageResponse, () => {}, directory));
      const name = browserComputerStorageName(persistentName);
      persistent = { source, kernelWasm, name };
      await phase("initialize OPFS kernel", () => owner.initFromOpfsImage({
        kernelWasm, vfsImageFile: source.file,
        experimentalResizablePersistenceName: name, persistentComputerName: name,
      }));
    }
  },
  async reopen() {
    if (!persistent) throw new Error("No persistent compatibility computer exists");
    await shutdownKernel();
    const owner = new BrowserKernel({ memoryProfile: "constrained", maxWorkers: 4 });
    kernel = owner;
    await owner.initFromOpfsImage({
      kernelWasm: persistent.kernelWasm, vfsImageFile: persistent.source.file,
      experimentalResizablePersistenceName: persistent.name, persistentComputerName: persistent.name,
      requireExistingRootfsPersistence: true,
    });
  },
  async run(path: string, argv: string[], env: string[] = [], uid = 1000) {
    const owner = kernel;
    if (!owner) throw new Error("The compatibility kernel is not initialized");
    const id = `compatibility-${++sequence}`;
    const spawned = await owner.spawnFromVfs(path, argv, {
      uid, gid: uid, cwd: "/work",
      env: ["HOME=/work", "PATH=/bin", "TMPDIR=/work/temporary", "SQLITE_TMPDIR=/work/temporary", "WASM_OPT=/bin/wasm-opt", "BINARYEN_CORES=1", ...env],
      ownedJob: { id, timeoutMs: 120_000 },
    });
    void spawned.exit.catch(() => {});
    let cursor = 0;
    let output = "";
    const deadline = Date.now() + 135_000;
    for (;;) {
      const result = await owner.readOwnedJob(id, cursor, 16384);
      if (result.expired) throw new Error("Compatibility command output expired");
      output = (output + result.chunks.map(chunk => new TextDecoder().decode(chunk.bytes)).join("")).slice(-65536);
      cursor = result.next;
      if (result.terminationObserved) {
        await owner.releaseOwnedJob(id);
        return { status: result.status, exitCode: result.exitCode, output };
      }
      if (Date.now() >= deadline) throw new Error("Compatibility command did not retire");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  },
  async read(path: string) {
    if (!kernel) throw new Error("The compatibility kernel is not initialized");
    const bytes = await kernel.readFileFromVfs(path);
    return bytes === null ? null : Array.from(bytes);
  },
  async identity(path: string) {
    if (!kernel) throw new Error("The compatibility kernel is not initialized");
    const bytes = await kernel.readFileFromVfs(path);
    if (bytes === null) return null;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer));
    return { size: bytes.byteLength, sha256: Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("") };
  },
  async write(path: string, bytes: number[]) {
    if (!kernel) throw new Error("The compatibility kernel is not initialized");
    await kernel.writeFileToVfs(path, Uint8Array.from(bytes));
  },
  async destroy() {
    await shutdownKernel();
    if (persistent !== null) {
      await persistent.source.remove();
      persistent = null;
    }
  },
};

Object.assign(window, { __programCompatibility: fixture });
export type ProgramCompatibilityFixture = typeof fixture;
document.getElementById("status")!.textContent = "Program compatibility fixture ready";
