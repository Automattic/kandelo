import type { BrowserKernel } from "@host/browser-kernel-host";
import { browserPersistenceDirectory } from "@host/browser-computer-storage";
import type { BrowserPersistenceComputerLease } from "@host/browser-persistence-computer-lease";
import type { BrowserPersistenceJournalLease } from "@host/browser-persistence-journal-lease";
import {
  KANDELO_DEMO_CONFIG_PATH,
  MAX_KANDELO_DEMO_CONFIG_BYTES,
  parseKandeloDemoConfig,
  resolveDemoInit,
  validateKandeloDemoConfig,
  type KandeloDemoConfig,
} from "../../../../../web-libs/kandelo-session/src/demo-config";
import { MAX_DINIT_SERVICE_CLOSURE, MAX_DINIT_SERVICE_FILE_BYTES, parseDinitBootTargets } from "../../../../../web-libs/kandelo-session/src/dinit-boot-targets";
import {
  EXPERIMENTAL_TERMINAL_SESSION_PATH,
  MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES,
  parseExperimentalTerminalSession,
} from "../../../../../web-libs/kandelo-session/src/experimental-terminal-session";
import {
  authorizeFixedPersistenceSnapshotPublication,
  discardFixedPersistenceStagedReplacement,
  loadFixedPersistenceImageHandle,
  publishFixedPersistenceReplacement,
  stageFixedPersistenceSnapshotReplacement,
  type FixedPersistenceImageHandle,
} from "./fixed-persistence-image";
import { withPersistentKernelCleanup } from "./persistent-kernel-lifecycle";

export interface PersistentImageCheckpointOptions {
  name: string;
  mode?: "fixed" | "resizable";
  identity: string;
  journalName: string;
  kernelWasm: ArrayBuffer;
  createKernel: () => BrowserKernel;
  closeKernel: (kernel: BrowserKernel) => Promise<void>;
  lazyUrlMapForImage?: (assets: FixedPersistenceImageHandle["lazyAssets"]) => Record<string, string>;
  lazyAssetDirectoryForImage?: (assets: FixedPersistenceImageHandle["lazyAssets"]) => string | undefined;
  persistenceComputerLease?: BrowserPersistenceComputerLease;
  releaseLease: () => Promise<void>;
  assertCurrent?: () => void;
  onProgress?: (label: string, progress?: { completed: number; total?: number }) => void;
  validateCandidate?: (kernel: BrowserKernel, staged: FixedPersistenceImageHandle) => Promise<void>;
}

export async function assertPersistentImageBootMetadata(
  kernel: Pick<BrowserKernel, "readFileRangeFromVfs">,
  composition: FixedPersistenceImageHandle["composition"],
): Promise<void> {
  const configBytes = await kernel.readFileRangeFromVfs(KANDELO_DEMO_CONFIG_PATH, 0, MAX_KANDELO_DEMO_CONFIG_BYTES + 1);
  if (configBytes === null || configBytes.byteLength > MAX_KANDELO_DEMO_CONFIG_BYTES) {
    throw new Error("persistent image boot configuration changed after composition");
  }
  const config = parseKandeloDemoConfig(new TextDecoder("utf-8", { fatal: true }).decode(configBytes));
  if (config === null) throw new Error("persistent image boot configuration is unsupported");
  validateKandeloDemoConfig(config);
  if (JSON.stringify(config) !== JSON.stringify(composition.imageConfig)) {
    throw new Error("persistent image boot configuration changed after composition");
  }
  const sessionBytes = await kernel.readFileRangeFromVfs(EXPERIMENTAL_TERMINAL_SESSION_PATH, 0, MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES + 1);
  if (sessionBytes === null || sessionBytes.byteLength > MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES) {
    throw new Error("persistent image terminal session changed after composition");
  }
  const session = parseExperimentalTerminalSession(
    new TextDecoder("utf-8", { fatal: true }).decode(sessionBytes),
  );
  if (JSON.stringify(session) !== JSON.stringify(composition.terminalSession)) {
    throw new Error("persistent image terminal session changed after composition");
  }
  const services = await persistentImageServices(kernel, config, composition.profileId);
  if (JSON.stringify(services) !== JSON.stringify(composition.requiredServices)) {
    throw new Error("persistent image dinit service closure changed after composition");
  }
}

export async function persistentImageServices(
  kernel: Pick<BrowserKernel, "readFileRangeFromVfs">,
  config: KandeloDemoConfig,
  profileId: string,
): Promise<string[]> {
  const init = resolveDemoInit(config, profileId);
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
    const bytes = await kernel.readFileRangeFromVfs(`/etc/dinit.d/${name}`, 0, MAX_DINIT_SERVICE_FILE_BYTES + 1);
    if (bytes === null) throw new Error(`persistent image dinit service is missing: ${name}`);
    for (const dependency of parseDinitBootTargets(bytes, name)) pending.push(dependency);
  }
  return services;
}

async function releaseCheckpointJournalLeases(
  source: BrowserPersistenceJournalLease | null,
  target: BrowserPersistenceJournalLease | null,
): Promise<void> {
  const releases = [target, source]
    .filter((lease): lease is BrowserPersistenceJournalLease => lease !== null)
    .map((lease) => Promise.resolve().then(() => lease()));
  const outcomes = await Promise.allSettled(releases);
  const failures = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, "persistent image journal release failed");
}

export async function checkpointPersistentImage(
  options: PersistentImageCheckpointOptions,
): Promise<{ previous: FixedPersistenceImageHandle; staged: FixedPersistenceImageHandle }> {
  const {
    name, mode = "fixed", identity, journalName, kernelWasm, createKernel, closeKernel, lazyUrlMapForImage, lazyAssetDirectoryForImage,
    persistenceComputerLease, releaseLease, assertCurrent, onProgress, validateCandidate,
  } = options;
  assertCurrent?.();
  onProgress?.("Checking saved filesystem");
  const previous = await loadFixedPersistenceImageHandle(name, identity);
  if (previous === null || !previous.journalInitialized || previous.journalName !== journalName) {
    throw new Error("persistent image changed during checkpoint");
  }
  const lazyUrlMap = lazyUrlMapForImage?.(previous.lazyAssets);
  const lazyAssetDirectory = lazyAssetDirectoryForImage?.(previous.lazyAssets);
  const snapshotDirectory = await browserPersistenceDirectory(name);
  const snapshotName = `${name}.snapshot-${crypto.randomUUID()}.vfs`;
  const snapshotFile = await snapshotDirectory.getFileHandle(snapshotName, { create: true });
  let sourceJournalLease: BrowserPersistenceJournalLease | null = null;
  let staged: FixedPersistenceImageHandle;
  try {
    const source = createKernel();
    let sourceHandoffReady = false;
    const integrity = await withPersistentKernelCleanup(async () => {
      onProgress?.("Replaying filesystem journal");
      await source.initFromOpfsImage({
        kernelWasm,
        vfsImageFile: previous.file,
        persistentImageBinding: previous.persistentImageBinding,
        lazyUrlMap,
        lazyAssetDirectory,
        ...(mode === "resizable"
          ? { experimentalResizablePersistenceName: previous.journalName }
          : { experimentalFixedPersistenceName: previous.journalName }),
        persistentComputerName: name,
        persistenceComputerLease,
        requireExistingRootfsPersistence: true,
      });
      await assertPersistentImageBootMetadata(source, previous.composition);
      onProgress?.("Preparing filesystem snapshot");
      const integrity = await source.exportRootfsImageToFile(snapshotFile, (progress) => {
        onProgress?.(progress.phase === "writing" ? "Writing filesystem snapshot"
          : progress.phase === "flushing" ? "Flushing filesystem snapshot"
          : "Verifying filesystem snapshot", progress);
      });
      source.reservePersistentJournalLeaseForHandoff();
      sourceHandoffReady = true;
      return integrity;
    }, async () => {
      onProgress?.("Closing snapshot kernel");
      await closeKernel(source);
      if (sourceHandoffReady) sourceJournalLease = source.takePersistentJournalLeaseAfterDestroy();
    });
    assertCurrent?.();
    onProgress?.("Staging saved filesystem");
    if (sourceJournalLease === null) throw new Error("persistent image checkpoint source handoff is incomplete");
    staged = await stageFixedPersistenceSnapshotReplacement(
      name, identity, snapshotFile, integrity,
      previous.lazyAssets, previous.composition, assertCurrent, sourceJournalLease, previous.integrityPolicy,
    );
  } catch (error) {
    await releaseCheckpointJournalLeases(sourceJournalLease, null);
    throw error;
  } finally {
    await snapshotDirectory.removeEntry(snapshotName).catch(() => {});
  }
  let candidateQuiescent = true;
  let targetJournalLease: BrowserPersistenceJournalLease | null = null;
  try {
    assertCurrent?.();
    onProgress?.("Validating saved filesystem");
    const candidate = createKernel();
    candidateQuiescent = false;
    let candidateHandoffReady = false;
    await withPersistentKernelCleanup(async () => {
      await candidate.initFromOpfsImage({
        kernelWasm,
        vfsImageFile: staged.file,
        persistentImageBinding: staged.persistentImageBinding,
        lazyUrlMap,
        lazyAssetDirectory,
        ...(mode === "resizable"
          ? { experimentalResizablePersistenceName: staged.journalName }
          : { experimentalFixedPersistenceName: staged.journalName }),
        persistentComputerName: name,
        persistenceComputerLease,
      });
      await assertPersistentImageBootMetadata(candidate, previous.composition);
      await validateCandidate?.(candidate, staged);
      candidate.reservePersistentJournalLeaseForHandoff();
      candidateHandoffReady = true;
    }, async () => {
      onProgress?.("Closing validation kernel");
      await closeKernel(candidate);
      candidateQuiescent = true;
      if (candidateHandoffReady) targetJournalLease = candidate.takePersistentJournalLeaseAfterDestroy();
    });
    assertCurrent?.();
    if (sourceJournalLease === null || targetJournalLease === null) {
      throw new Error("persistent image checkpoint journal handoff is incomplete");
    }
    onProgress?.("Publishing saved filesystem");
    await authorizeFixedPersistenceSnapshotPublication(staged, sourceJournalLease, targetJournalLease);
    await publishFixedPersistenceReplacement(
      name, identity, previous, staged, assertCurrent, persistenceComputerLease,
      { source: sourceJournalLease, target: targetJournalLease },
    );
    await releaseCheckpointJournalLeases(sourceJournalLease, targetJournalLease);
    await releaseLease();
    return { previous, staged };
  } catch (error) {
    if (candidateQuiescent) {
      const cleanupFailures: unknown[] = [];
      for (const cleanup of [
        () => releaseCheckpointJournalLeases(sourceJournalLease, targetJournalLease),
        releaseLease,
        () => discardFixedPersistenceStagedReplacement(name, identity, staged),
      ]) {
        try {
          await cleanup();
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], "persistent image checkpoint cleanup failed");
      }
    }
    throw error;
  }
}
