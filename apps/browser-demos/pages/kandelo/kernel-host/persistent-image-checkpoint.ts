import { BrowserKernel } from "@host/browser-kernel-host";
import type { BrowserPersistenceComputerLease } from "@host/browser-persistence-computer-lease";
import {
  KANDELO_DEMO_CONFIG_PATH,
  MAX_KANDELO_DEMO_CONFIG_BYTES,
  parseKandeloDemoConfig,
  resolveDemoInit,
  validateKandeloDemoConfig,
} from "../../../../../web-libs/kandelo-session/src/demo-config";
import { MAX_DINIT_SERVICE_CLOSURE, parseDinitBootTargets } from "../../../../../web-libs/kandelo-session/src/dinit-boot-targets";
import {
  EXPERIMENTAL_TERMINAL_SESSION_PATH,
  MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES,
  parseExperimentalTerminalSession,
} from "../../../../../web-libs/kandelo-session/src/experimental-terminal-session";
import {
  loadFixedPersistenceImageHandle,
  publishFixedPersistenceReplacement,
  stageFixedPersistenceSnapshotReplacement,
  type FixedPersistenceImageHandle,
} from "./fixed-persistence-image";

export interface PersistentImageCheckpointOptions {
  name: string;
  identity: string;
  journalName: string;
  kernelWasm: ArrayBuffer;
  createKernel: () => BrowserKernel;
  closeKernel: (kernel: BrowserKernel) => Promise<void>;
  lazyUrlMapForImage: (assets: FixedPersistenceImageHandle["lazyAssets"]) => Record<string, string>;
  persistenceComputerLease?: BrowserPersistenceComputerLease;
  releaseLease: () => Promise<void>;
  assertCurrent?: () => void;
  onProgress?: (label: string) => void;
  validateCandidate?: (kernel: BrowserKernel) => Promise<void>;
}

export async function assertPersistentImageBootMetadata(
  kernel: Pick<BrowserKernel, "readFileFromVfs">,
  composition: FixedPersistenceImageHandle["composition"],
): Promise<void> {
  const configBytes = await kernel.readFileFromVfs(KANDELO_DEMO_CONFIG_PATH);
  if (configBytes === null || configBytes.byteLength > MAX_KANDELO_DEMO_CONFIG_BYTES) {
    throw new Error("persistent image boot configuration changed after composition");
  }
  const config = parseKandeloDemoConfig(new TextDecoder("utf-8", { fatal: true }).decode(configBytes));
  if (config === null) throw new Error("persistent image boot configuration is unsupported");
  validateKandeloDemoConfig(config);
  if (JSON.stringify(config) !== JSON.stringify(composition.imageConfig)) {
    throw new Error("persistent image boot configuration changed after composition");
  }
  const sessionBytes = await kernel.readFileFromVfs(EXPERIMENTAL_TERMINAL_SESSION_PATH);
  if (sessionBytes === null || sessionBytes.byteLength > MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES) {
    throw new Error("persistent image terminal session changed after composition");
  }
  const session = parseExperimentalTerminalSession(
    new TextDecoder("utf-8", { fatal: true }).decode(sessionBytes),
  );
  if (JSON.stringify(session) !== JSON.stringify(composition.terminalSession)) {
    throw new Error("persistent image terminal session changed after composition");
  }
  const init = resolveDemoInit(config, composition.profileId);
  const pending = init !== null && "target" in init ? [init.target] : [];
  const seen = new Set<string>();
  const services: string[] = [];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    services.push(name);
    if (seen.size > MAX_DINIT_SERVICE_CLOSURE) {
      throw new Error(`persistent image dinit tree exceeds ${MAX_DINIT_SERVICE_CLOSURE} services`);
    }
    const bytes = await kernel.readFileFromVfs(`/etc/dinit.d/${name}`);
    if (bytes === null) throw new Error(`persistent image dinit service is missing: ${name}`);
    for (const dependency of parseDinitBootTargets(bytes, name)) pending.push(dependency);
  }
  if (JSON.stringify(services) !== JSON.stringify(composition.requiredServices)) {
    throw new Error("persistent image dinit service closure changed after composition");
  }
}

export async function checkpointPersistentImage(
  options: PersistentImageCheckpointOptions,
): Promise<{ previous: FixedPersistenceImageHandle; staged: FixedPersistenceImageHandle }> {
  const {
    name, identity, journalName, kernelWasm, createKernel, closeKernel, lazyUrlMapForImage,
    persistenceComputerLease, releaseLease, assertCurrent, onProgress, validateCandidate,
  } = options;
  assertCurrent?.();
  onProgress?.("exporting persistent VFS image");
  const previous = await loadFixedPersistenceImageHandle(name, identity);
  if (previous === null || !previous.journalInitialized || previous.journalName !== journalName) {
    throw new Error("persistent image changed during checkpoint");
  }
  const lazyUrlMap = lazyUrlMapForImage(previous.lazyAssets);
  const snapshotDirectory = await (await navigator.storage.getDirectory())
    .getDirectoryHandle("kandelo-persistent-overlay", { create: true });
  const snapshotName = `${name}.snapshot-${crypto.randomUUID()}.vfs`;
  const snapshotFile = await snapshotDirectory.getFileHandle(snapshotName, { create: true });
  let staged: FixedPersistenceImageHandle;
  try {
    const source = createKernel();
    let integrity: Awaited<ReturnType<BrowserKernel["exportRootfsImageToFile"]>>;
    try {
      await source.initFromOpfsImage({
        kernelWasm,
        vfsImageFile: previous.file,
        integrity: { length: previous.length, chunkBytes: 1024 * 1024, chunkSha256: previous.chunkSha256 },
        lazyUrlMap,
        experimentalFixedPersistenceName: previous.journalName,
        persistentComputerName: name,
        persistenceComputerLease,
        requireExistingRootfsPersistence: true,
      });
      await assertPersistentImageBootMetadata(source, previous.composition);
      integrity = await source.exportRootfsImageToFile(snapshotFile);
    } finally {
      await closeKernel(source);
    }
    assertCurrent?.();
    onProgress?.("staging persistent VFS image");
    staged = await stageFixedPersistenceSnapshotReplacement(
      name, identity, snapshotFile, integrity,
      previous.lazyAssets, previous.composition, assertCurrent,
    );
  } finally {
    await snapshotDirectory.removeEntry(snapshotName).catch(() => {});
  }
  assertCurrent?.();
  onProgress?.("validating persistent VFS image");
  const candidate = createKernel();
  try {
    await candidate.initFromOpfsImage({
      kernelWasm,
      vfsImageFile: staged.file,
      integrity: { length: staged.length, chunkBytes: 1024 * 1024, chunkSha256: staged.chunkSha256 },
      lazyUrlMap,
      experimentalFixedPersistenceName: staged.journalName,
      persistentComputerName: name,
      persistenceComputerLease,
    });
    await assertPersistentImageBootMetadata(candidate, previous.composition);
    await validateCandidate?.(candidate);
  } finally {
    await closeKernel(candidate);
  }
  assertCurrent?.();
  await releaseLease();
  onProgress?.("publishing persistent VFS image");
  await publishFixedPersistenceReplacement(name, identity, previous, staged, assertCurrent);
  return { previous, staged };
}
