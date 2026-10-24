import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

const { load, stage } = vi.hoisted(() => ({ load: vi.fn(), stage: vi.fn() }));
vi.mock("../../apps/browser-demos/lib/kernel-owned-boot", () => ({ loadPositionedImageWriterModuleBytes: load }));
vi.mock("../../apps/browser-demos/pages/kandelo/kernel-host/persistent-image-codec", () => ({
  stageSourceImageFile: stage,
  UnprovenImageCodecCleanupError: class extends Error {
    readonly retainTarget = true;
    constructor(cause: unknown) {
      super("Persistent image worker cleanup is unproven; retain its staged target", { cause });
    }
  },
}));

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); load.mockReset(); stage.mockReset(); });

function fixture() {
  const files = new Map<string, { name: string }>();
  const held = new Set<string>();
  const directory = { keys: async function* () { yield* files.keys(); },
    getFileHandle: vi.fn(async (name: string) => { const file = { name }; files.set(name, file); return file; }),
    removeEntry: vi.fn(async (name: string) => { files.delete(name); }),
  };
  const root = { getDirectoryHandle: vi.fn(async () => directory) };
  const storage = { getDirectory: vi.fn(async () => root) };
  const locks = { request: vi.fn(async (name: string, options: unknown, callback?: (lock: unknown) => Promise<unknown>) => {
    const operation = (callback ?? options) as (lock: unknown) => Promise<unknown>;
    if (held.has(name)) {
      if ((options as { ifAvailable?: boolean }).ifAvailable) return operation(null);
      throw new Error("unexpected lock contention");
    }
    held.add(name);
    try { return await operation({ name }); } finally { held.delete(name); }
  }) };
  vi.stubGlobal("navigator", { locks, storage });
  load.mockResolvedValue(new Uint8Array([0, 97, 115, 109]));
  stage.mockImplementation(async (_file, _module, _maximum, chunks) => {
    const digest = createHash("sha256");
    let length = 0;
    for await (const bytes of chunks) { digest.update(bytes); length += bytes.length; }
    return { length, imageSha256: digest.digest("hex") };
  });
  const response = () => new Response(Uint8Array.of(11, 17, 23, 29));
  return { directory: directory as unknown as FileSystemDirectoryHandle, files, held, root, storage, response, opens: directory.getFileHandle };
}

it("refuses staging dispatch after quarantine during module loading and removes the healthy unopened stage", async () => {
  const fixtureState = fixture();
  const { stageRawVfsSourceImage } = await import("../../apps/browser-demos/pages/kandelo/kernel-host/opfs-source-image");
  const protectedSource = await stageRawVfsSourceImage(fixtureState.response(), () => {}, fixtureState.directory);
  const initialNames = [...fixtureState.files.keys()];
  let resume!: (bytes: Uint8Array) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  load.mockImplementationOnce(() => { entered(); return new Promise<Uint8Array>(resolve => { resume = resolve; }); });
  const pending = stageRawVfsSourceImage(fixtureState.response(), () => {}, fixtureState.directory);
  await started;
  protectedSource.retain();
  resume(new Uint8Array([0, 97, 115, 109]));
  await expect(pending).rejects.toThrow(/quarantined/);
  expect(stage).toHaveBeenCalledOnce();
  expect([...fixtureState.files.keys()]).toEqual(initialNames);
  expect(fixtureState.held.size).toBe(1);
  const before = fixtureState.opens.mock.calls.length;
  await expect(stageRawVfsSourceImage(fixtureState.response(), () => {}, fixtureState.directory)).rejects.toThrow(/quarantined/);
  expect(fixtureState.opens.mock.calls.length).toBe(before);
});

it("refuses a creating directory open after quarantine during its parent lookup", async () => {
  const fixtureState = fixture();
  const { stageRawVfsSourceImage } = await import("../../apps/browser-demos/pages/kandelo/kernel-host/opfs-source-image");
  const protectedSource = await stageRawVfsSourceImage(fixtureState.response(), () => {}, fixtureState.directory);
  let resume!: (root: typeof fixtureState.root) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  fixtureState.storage.getDirectory.mockImplementationOnce(() => { entered(); return new Promise(resolve => { resume = resolve; }); });
  const pending = stageRawVfsSourceImage(fixtureState.response(), () => {});
  await started;
  protectedSource.retain();
  resume(fixtureState.root);
  await expect(pending).rejects.toThrow(/quarantined/);
  expect(fixtureState.root.getDirectoryHandle).not.toHaveBeenCalled();
  expect(stage).toHaveBeenCalledOnce();
});

it("removes an undispatched file when quarantine occurs during file creation", async () => {
  const fixtureState = fixture();
  const { stageRawVfsSourceImage } = await import("../../apps/browser-demos/pages/kandelo/kernel-host/opfs-source-image");
  const protectedSource = await stageRawVfsSourceImage(fixtureState.response(), () => {}, fixtureState.directory);
  const initialNames = [...fixtureState.files.keys()];
  let resume!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  fixtureState.opens.mockImplementationOnce(async (name: string) => {
    entered();
    await new Promise<void>(resolve => { resume = resolve; });
    const file = { name };
    fixtureState.files.set(name, file);
    return file;
  });
  const pending = stageRawVfsSourceImage(fixtureState.response(), () => {}, fixtureState.directory);
  await started;
  protectedSource.retain();
  resume();
  await expect(pending).rejects.toThrow(/quarantined/);
  expect(stage).toHaveBeenCalledOnce();
  expect(load).toHaveBeenCalledOnce();
  expect([...fixtureState.files.keys()]).toEqual(initialNames);
  expect(fixtureState.held.size).toBe(1);
});
