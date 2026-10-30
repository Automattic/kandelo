import type { ImageOwnedRuntimeLazyAssets } from "../../../lib/init/image-owned-runtime-urls";
import { browserPersistenceDirectory, browserReplacementJournalName, browserJournalBelongsToComputer } from "../../../../../host/src/browser-computer-storage";
import type { ComposeImageResult } from "./image-composer";
import type { OpfsImageIntegrity } from "../../../../../host/src/vfs/opfs-image-reader";
import { snapshotPersistentImageReadBinding, type PersistentImageReadBinding } from "../../../../../host/src/vfs/image-integrity";
import type { PersistentImageIntegrityPolicy } from "../../../../../images/vfs/lib/kandelo-image-fs";
import { loadPositionedImageWriterModuleBytes } from "../../../lib/kernel-owned-boot";
import { inspectPersistentImageFile, writePersistentImageFile, runPersistentImageControl, UnprovenImageCodecCleanupError } from "./persistent-image-codec";
import { runWithPersistentImageProgress, type PersistentImageProgress } from "./persistent-image-progress";
import { ERRNO } from "../../../../../host/src/generated/abi";
import { isStagedRootfsImageIntegrity } from "../../../../../host/src/vfs/staged-rootfs-image";
import { ImageManifestMemoryScope, imageJsonOperationMemory, MAX_IMAGE_MANIFEST_BYTES } from "../../../../../host/src/vfs/image-manifest-memory";
import { StorageMemoryBudget, storageMetadataError } from "../../../../../host/src/vfs/storage-memory-budget";
import { selectImageBinding, validateImageBindingState, UnprovenImageFreshnessError, type ImageBindingIdentity, type ImageBindingState, type ImageBindingPolicyCall } from "../../../../../host/src/vfs/image-binding-state";
import { parseSealedGenerationSlot } from "../../../../../host/src/vfs/overlay-generation-seal";
export { UnprovenImageFreshnessError } from "../../../../../host/src/vfs/image-binding-state";
import { sha256 as incrementalSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { parseKandeloDemoConfig } from "../../../../../web-libs/kandelo-session/src/demo-config";
import { parseExperimentalTerminalSession } from "../../../../../web-libs/kandelo-session/src/experimental-terminal-session";
import { acquireBrowserPersistenceComputerLease, withHeldBrowserPersistenceComputerLease, type BrowserPersistenceComputerLease } from "../../../../../host/src/browser-persistence-computer-lease";
import { browserPersistenceJournalLockName, withHeldBrowserPersistenceJournal, withHeldBrowserPersistenceJournals, withIdleBrowserPersistenceJournals, type BrowserPersistenceJournalLease } from "../../../../../host/src/browser-persistence-journal-lease";

const FORMAT_V6 = "kandelo-fixed-rootfs-image-v6";
const IMAGE_FORMAT = "kandelo-checked-image-v1";

class UnsupportedPersistenceFormatError extends Error {}
const BINDING_FORMAT = "kandelo-active-rootfs-binding-v1";
const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const CHUNK_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const manifestMemory = imageJsonOperationMemory;

export function fixedPersistenceManifestMemoryUsage(): ReturnType<StorageMemoryBudget["snapshot"]> {
  return manifestMemory.snapshot();
}
const manifestScopes = new Map<string, ImageManifestMemoryScope>();
const imageBindingPolicy: ImageBindingPolicyCall = async (operation, input) =>
  runPersistentImageControl(await loadPositionedImageWriterModuleBytes(), operation, input);
const snapshotPublications = new WeakMap<FixedPersistenceImageHandle, {
  source: BrowserPersistenceJournalLease;
  target: BrowserPersistenceJournalLease | null;
  sourceContent: string;
  sourceGeneration: number;
  targetDigest: string;
}>();

function manifestScope(name: string): ImageManifestMemoryScope {
  const scope = manifestScopes.get(name);
  if (scope === undefined) throw new Error("Image manifest operation has no memory owner");
  return scope;
}

function encodeManifestValue(name: string, value: unknown): string {
  return manifestScope(name).encode(value);
}

async function readManifestText(file: FileSystemFileHandle, name: string): Promise<string> {
  const snapshot = await file.getFile();
  manifestScope(name).retain(snapshot.size);
  return snapshot.text();
}

type StoredComposition = Pick<
  ComposeImageResult,
  "imageConfig" | "profileId" | "terminalSession" | "requiredServices"
>;

interface ImageManifest {
  format: typeof FORMAT_V6;
  imageFormat: typeof IMAGE_FORMAT;
  payloadLength: number;
  integrityPolicy: PersistentImageIntegrityPolicy;
  identity: string;
  length: number;
  sha256?: string;
  imageFileName?: string;
  journalName?: string;
  journalNameSha256?: string;
  journalInitialized?: boolean;
  imageIdentitySha256?: string;
  generation?: number;
  lazyAssets?: ImageOwnedRuntimeLazyAssets | null;
  lazyAssetsSha256?: string;
  chunkSha256?: string[];
  chunkSha256Digest?: string;
  composition?: StoredComposition;
  compositionSha256?: string;
}

interface ActiveImageBinding {
  format: typeof BINDING_FORMAT;
  phase: "prepared" | "active";
  target: ImageManifest;
  source?: ImageManifest;
  sha256: string;
}

export interface FixedPersistenceImageHandle {
  file: FileSystemFileHandle;
  imageFileName?: string;
  journalName: string;
  journalInitialized: boolean;
  imageIdentitySha256?: string;
  length: number;
  generation: number;
  payloadLength: number;
  integrityPolicy: PersistentImageIntegrityPolicy;
  persistentImageBinding: PersistentImageReadBinding;
  lazyAssets?: ImageOwnedRuntimeLazyAssets;
  composition: StoredComposition;
  recovery?: {
    currentManifestSha256: string | null;
    activeBindingSha256: string | null;
    selectedManifestSha256: string;
    choice: "primary" | "target" | "source";
  };
}

export interface PersistentImageStream {
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
  payloadLength: number;
  integrityPolicy: PersistentImageIntegrityPolicy;
}

export function assertFixedPersistenceBootAllowed(
  name: string,
  candidateEvidence: boolean,
  boot: { inputs?: readonly unknown[]; parameters?: { runScript?: unknown } },
): void {
  fileNames(name);
  if (candidateEvidence) {
    throw new Error("experimental persistence is unavailable for protected candidate boots");
  }
  if (boot.inputs?.length || boot.parameters?.runScript !== undefined) {
    throw new Error("experimental persistence refuses boot-link inputs and scripts");
  }
}

function fileNames(name: string): { image: string; manifest: string; previousManifest: string; binding: string } {
  if (!NAME_PATTERN.test(name)) throw new Error("invalid experimental persistence name");
  return {
    image: `${name}.base`,
    manifest: `${name}.base.json`,
    previousManifest: `${name}.previous.base.json`,
    binding: `${name}.active.base.json`,
  };
}

async function directory(name: string): Promise<FileSystemDirectoryHandle> {
  return browserPersistenceDirectory(name);
}

async function existingFile(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle | null> {
  try {
    return await parent.getFileHandle(name);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function manifestSha256(
  parent: FileSystemDirectoryHandle,
  fileName: string,
): Promise<string | null> {
  const file = await existingFile(parent, fileName);
  if (file === null) return null;
  const snapshot = await file.getFile();
  if (snapshot.size > MAX_IMAGE_MANIFEST_BYTES) throw storageMetadataError();
  const hash = incrementalSha256.create();
  for (let offset = 0; offset < snapshot.size; offset += CHUNK_BYTES) {
    hash.update(new Uint8Array(await snapshot.slice(offset, offset + CHUNK_BYTES).arrayBuffer()));
  }
  return bytesToHex(hash.digest());
}

interface ImageManifestMetadata {
  manifest: ImageManifest;
  lazyAssets?: ImageOwnedRuntimeLazyAssets;
  lazyAssetsRecorded: boolean;
  composition?: StoredComposition;
}

type SavedImage = ImageManifestMetadata & { imageFile: FileSystemFileHandle };

async function readImageManifestAt(
  parent: FileSystemDirectoryHandle,
  name: string,
  identity: string,
  manifestName: string,
): Promise<ImageManifestMetadata | null> {
  const manifestFile = await existingFile(parent, manifestName);
  if (manifestFile === null) {
    if (await existingFile(parent, fileNames(name).image) === null) return null;
    throw new Error("experimental persistence base image is incomplete; refusing to boot");
  }
  const text = await readManifestText(manifestFile, name);
  let manifest: ImageManifest;
  try { manifest = JSON.parse(text) as ImageManifest; }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error("experimental persistence base image manifest is invalid");
  }
  return validateImageManifest(name, identity, manifest);
}

async function validateImageManifest(
  name: string,
  identity: string,
  manifest: ImageManifest,
): Promise<ImageManifestMetadata> {
  if (typeof manifest?.format === "string" && /^kandelo-fixed-rootfs-image-v[0-9]+$/.test(manifest.format)
    && manifest.format !== FORMAT_V6) {
    throw new UnsupportedPersistenceFormatError("Unsupported persistent image manifest version; refusing to select an older generation");
  }
  if (typeof manifest?.imageFormat === "string" && manifest.imageFormat !== IMAGE_FORMAT) {
    throw new UnsupportedPersistenceFormatError("Unsupported persistent checked-image format; refusing to select an older generation");
  }
  if (
    manifest?.format !== FORMAT_V6 ||
    manifest.imageFormat !== IMAGE_FORMAT ||
    !Number.isSafeInteger(manifest.payloadLength) || manifest.payloadLength <= 0 || manifest.payloadLength >= manifest.length ||
    (manifest.integrityPolicy !== "crc32c" && manifest.integrityPolicy !== "sha256") ||
    Object.hasOwn(manifest, "imageSha256") ||
    manifest.identity !== identity ||
    !Number.isSafeInteger(manifest.length) ||
    manifest.length <= 0 ||
    manifest.sha256 !== undefined ||
    typeof manifest.imageFileName !== "string" ||
    !new RegExp(`^${name}\\.[0-9a-f-]{36}\\.base$`).test(manifest.imageFileName)
  ) {
    throw new Error("experimental persistence base image belongs to a different computer");
  }
  if (!Number.isSafeInteger(manifest.generation) || manifest.generation! < 0) {
    throw new Error("experimental persistence image generation is invalid");
  }
  {
    if (
      typeof manifest.journalName !== "string" ||
      !browserJournalBelongsToComputer(name, manifest.journalName)
    ) {
      throw new Error("experimental persistence journal namespace is invalid");
    }
    if (hasJournalBinding(manifest) && typeof manifest.journalInitialized !== "boolean") {
      throw new Error("experimental persistence journal initialization state is invalid");
    }
    const binding = encodeManifestValue(name,
      [manifest.identity, manifest.imageFileName, manifest.journalName, manifest.journalInitialized, manifest.generation]);
    if (
      !SHA256_PATTERN.test(manifest.journalNameSha256 ?? "") ||
      await sha256(new TextEncoder().encode(binding)) !== manifest.journalNameSha256
    ) {
      throw new Error("experimental persistence journal namespace is damaged");
    }
  }
  if (!SHA256_PATTERN.test(manifest.imageIdentitySha256 ?? "")) {
    throw new Error("experimental persistence image digest is invalid");
  }
  const lazyAssetsRecorded = Object.hasOwn(manifest, "lazyAssets");
  const lazyAssets = parseLazyAssets(manifest.lazyAssets);
  if (lazyAssetsRecorded) {
    if (
      !SHA256_PATTERN.test(manifest.lazyAssetsSha256 ?? "") ||
      await sha256(new TextEncoder().encode(encodeManifestValue(name, manifest.lazyAssets))) !==
        manifest.lazyAssetsSha256
    ) {
      throw new Error("experimental persistence base image manifest is damaged");
    }
  } else if (manifest.lazyAssetsSha256 !== undefined) {
    throw new Error("experimental persistence base image manifest is invalid");
  }
  if (manifest.chunkSha256 !== undefined || manifest.chunkSha256Digest !== undefined) {
    throw new Error("experimental persistence base image manifest is invalid");
  }
  let composition: StoredComposition | undefined;
  if (manifest.composition !== undefined) {
    if (
      !SHA256_PATTERN.test(manifest.compositionSha256 ?? "") ||
      await sha256(new TextEncoder().encode(encodeManifestValue(name, manifest.composition))) !==
        manifest.compositionSha256
    ) {
      throw new Error("experimental persistence base image manifest is damaged");
    }
    composition = parseComposition(manifest.composition, name);
  } else if (manifest.compositionSha256 !== undefined) {
    throw new Error("experimental persistence base image manifest is invalid");
  }
  if (
    composition === undefined || !lazyAssetsRecorded
  ) {
    throw new Error("experimental persistence base image manifest is invalid");
  }
  return { manifest, lazyAssets, lazyAssetsRecorded, composition };
}

async function openSavedImage(
  parent: FileSystemDirectoryHandle,
  name: string,
  metadata: ImageManifestMetadata,
): Promise<SavedImage> {
  const imageFile = await existingFile(parent, metadata.manifest.imageFileName!);
  if (imageFile === null) throw new Error("experimental persistence base image is incomplete; refusing to boot");
  if ((await imageFile.getFile()).size !== metadata.manifest.length) {
    throw new Error("experimental persistence base image is damaged; refusing to boot");
  }
  return { ...metadata, imageFile };
}

async function readSavedImageAt(
  parent: FileSystemDirectoryHandle,
  name: string,
  identity: string,
  manifestName: string,
): Promise<SavedImage | null> {
  const metadata = await readImageManifestAt(parent, name, identity, manifestName);
  return metadata === null ? null : openSavedImage(parent, name, metadata);
}

function hasJournalBinding(manifest: ImageManifest | null | undefined): boolean {
  return manifest?.format === FORMAT_V6;
}

interface ActiveBindingView {
  record: ActiveImageBinding;
  target: ImageManifestMetadata;
  source: ImageManifestMetadata | null;
  state: ImageBindingState;
}

function isImageMetadataDamage(error: unknown): boolean {
  return error instanceof Error && !(error instanceof UnsupportedPersistenceFormatError)
    && error.message.startsWith("experimental persistence");
}

async function imageBindingIdentity(name: string, metadata: ImageManifestMetadata): Promise<ImageBindingIdentity> {
  const manifest = metadata.manifest;
  return {
    generation: manifest.generation ?? 0,
    digest: await sha256(new TextEncoder().encode(encodeManifestValue(name, manifest))),
    content: await sha256(new TextEncoder().encode(encodeManifestValue(name, [manifest.identity,
      manifest.imageFileName ?? fileNames(name).image, manifest.journalName ?? name,
      manifest.imageIdentitySha256, manifest.imageFormat, manifest.length, manifest.payloadLength, manifest.integrityPolicy,
      manifest.lazyAssetsSha256, manifest.compositionSha256]))),
    initialized: !hasJournalBinding(manifest) || manifest.journalInitialized === true,
    version: Number(manifest.format.slice(manifest.format.lastIndexOf("v") + 1)),
  };
}

async function readActiveBinding(
  parent: FileSystemDirectoryHandle,
  name: string,
  identity: string,
): Promise<ActiveBindingView | null> {
  const file = await existingFile(parent, fileNames(name).binding);
  if (file === null) return null;
  let record: ActiveImageBinding;
  const text = await readManifestText(file, name);
  try { record = JSON.parse(text) as ActiveImageBinding; }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error("experimental persistence active binding is invalid");
  }
  if (typeof record?.format === "string" && /^kandelo-active-rootfs-binding-v[0-9]+$/.test(record.format)
    && record.format !== BINDING_FORMAT) throw new UnsupportedPersistenceFormatError("Unsupported persistent active binding version");
  if (record?.format !== BINDING_FORMAT || (record.phase !== "active" && record.phase !== "prepared")
    || !SHA256_PATTERN.test(record.sha256 ?? "")
    || (record.phase === "active" ? record.source !== undefined : record.source === undefined)) {
    throw new Error("experimental persistence active binding is invalid");
  }
  const target = await validateImageManifest(name, identity, record.target);
  const targetIdentity = await imageBindingIdentity(name, target);
  const source = record.source === undefined ? null : await validateImageManifest(name, identity, record.source);
  const sourceIdentity = source === null ? null : await imageBindingIdentity(name, source);
  const digest = await sha256(new TextEncoder().encode(encodeManifestValue(name,
    [BINDING_FORMAT, record.phase, targetIdentity.digest, sourceIdentity?.digest ?? null])));
  if (digest !== record.sha256) throw new Error("experimental persistence active binding is damaged");
  const state: ImageBindingState = record.phase === "active" ? { phase: "active", target: targetIdentity }
    : { phase: "prepared", target: targetIdentity, source: sourceIdentity! };
  try { await validateImageBindingState(imageBindingPolicy, state); }
  catch (error) {
    if (!(error instanceof UnprovenImageFreshnessError)) throw error;
    throw new Error("experimental persistence active binding state is invalid", { cause: error });
  }
  return { record, target, source, state };
}

async function writeActiveBinding(
  parent: FileSystemDirectoryHandle,
  name: string,
  identity: string,
  targetManifest: ImageManifest,
  sourceManifest?: ImageManifest,
  assertCurrent?: () => void,
): Promise<void> {
  const target = await validateImageManifest(name, identity, targetManifest);
  const targetIdentity = await imageBindingIdentity(name, target);
  const source = sourceManifest === undefined ? null : await validateImageManifest(name, identity, sourceManifest);
  const sourceIdentity = source === null ? null : await imageBindingIdentity(name, source);
  const phase = source === null ? "active" : "prepared";
  await validateImageBindingState(imageBindingPolicy, sourceIdentity === null ? { phase: "active", target: targetIdentity }
    : { phase: "prepared", target: targetIdentity, source: sourceIdentity });
  const record: ActiveImageBinding = {
    format: BINDING_FORMAT, phase, target: targetManifest,
    ...(sourceManifest === undefined ? {} : { source: sourceManifest }),
    sha256: await sha256(new TextEncoder().encode(encodeManifestValue(name,
      [BINDING_FORMAT, phase, targetIdentity.digest, sourceIdentity?.digest ?? null]))),
  };
  await writeManifest(parent, fileNames(name).binding, record, assertCurrent);
}

async function observeImageControl<Value>(operation: () => Promise<Value | null>): Promise<{
  value: Value | null; damaged: boolean;
}> {
  try { return { value: await operation(), damaged: false }; }
  catch (error) {
    if (!isImageMetadataDamage(error)) throw error;
    return { value: null, damaged: true };
  }
}

interface ImageSelection {
  saved: SavedImage;
  repair: boolean;
  choice: "primary" | "target" | "source";
}

async function selectSavedImage(
  parent: FileSystemDirectoryHandle,
  name: string,
  identity: string,
): Promise<ImageSelection | null> {
  const names = fileNames(name);
  const primary = await observeImageControl(() => readImageManifestAt(parent, name, identity, names.manifest));
  const active = await observeImageControl(() => readActiveBinding(parent, name, identity));
  const primaryIdentity = primary.value === null ? null : await imageBindingIdentity(name, primary.value);
  const plan = await selectImageBinding(imageBindingPolicy, primaryIdentity, active.value?.state ?? null);
  if (plan.choice === "empty") {
    if (primary.damaged || active.damaged || await existingFile(parent, names.previousManifest) !== null) {
      throw new UnprovenImageFreshnessError();
    }
    return null;
  }
  let choice = plan.choice;
  let metadata = choice === "primary" ? primary.value! : choice === "target" ? active.value!.target : active.value!.source!;
  let saved: SavedImage;
  try {
    saved = await openSavedImage(parent, name, metadata);
    if (plan.repair) await verifySavedBinding(parent, saved);
  } catch (error) {
    if (!isImageMetadataDamage(error)) throw error;
    if (choice !== "target" || active.value?.state.phase !== "prepared" || active.value.source === null) {
      throw new UnprovenImageFreshnessError(undefined, { cause: error });
    }
    choice = "source";
    metadata = active.value.source;
    saved = await openSavedImage(parent, name, metadata);
    await verifySavedBinding(parent, saved);
  }
  return { saved, repair: plan.repair || choice === "source", choice };
}
async function readSavedImage(
  parent: FileSystemDirectoryHandle,
  name: string,
  identity: string,
): Promise<SavedImage | null> {
  return (await selectSavedImage(parent, name, identity))?.saved ?? null;
}

async function verifySavedBinding(
  parent: FileSystemDirectoryHandle,
  saved: NonNullable<Awaited<ReturnType<typeof readSavedImageAt>>>,
): Promise<string> {
  const { manifest, imageFile } = saved;
  let geometry: { payloadLength: number };
  try {
    geometry = await inspectPersistentImageFile(imageFile, await loadPositionedImageWriterModuleBytes(),
      manifest.length, manifest.imageIdentitySha256!, manifest.integrityPolicy);
  } catch (error) {
    const errno = (error as { errno?: number } | null)?.errno;
    if (errno === ERRNO.EIO || errno === ERRNO.EINVAL) {
      throw new Error("experimental persistence image binding is damaged; refusing to boot", { cause: error });
    }
    throw error;
  }
  if (geometry.payloadLength !== manifest.payloadLength) {
    throw new Error("experimental persistence image geometry is damaged; refusing to boot");
  }
  if (manifest.journalInitialized) {
    await verifyJournalHeader(parent, manifest.journalName!, manifest.imageIdentitySha256!);
  }
  return manifest.imageIdentitySha256!;
}

function parseComposition(value: unknown, name: string): StoredComposition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("experimental persistence base image composition is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4 ||
    typeof record.profileId !== "string" || record.profileId.length > 128 ||
    !Array.isArray(record.requiredServices) ||
    record.requiredServices.length > 64 ||
    !record.requiredServices.every((service) => typeof service === "string" && service.length <= 4096)
  ) {
    throw new Error("experimental persistence base image composition is invalid");
  }
  try {
    const imageConfig = parseKandeloDemoConfig(encodeManifestValue(name, record.imageConfig));
    if (imageConfig === null) throw new Error("invalid demo config");
    const terminalSession = parseExperimentalTerminalSession(encodeManifestValue(name, record.terminalSession));
    return {
      imageConfig,
      profileId: record.profileId,
      terminalSession,
      requiredServices: record.requiredServices as string[],
    };
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "ENOMEM") throw error;
    throw new Error("experimental persistence base image composition is invalid");
  }
}

function parseLazyAssets(value: unknown): ImageOwnedRuntimeLazyAssets | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("experimental persistence base image manifest is invalid");
  }
  const assets = value as Record<string, unknown>;
  if (
    Object.keys(assets).length !== 3 ||
    typeof assets.deploymentBase !== "string" ||
    typeof assets.directoryUrl !== "string" ||
    typeof assets.manifestUrl !== "string" ||
    assets.deploymentBase.length > 4096 || assets.directoryUrl.length > 4096 || assets.manifestUrl.length > 4096
  ) {
    throw new Error("experimental persistence base image manifest is invalid");
  }
  return {
    deploymentBase: assets.deploymentBase,
    directoryUrl: assets.directoryUrl,
    manifestUrl: assets.manifestUrl,
  };
}

async function locked<T>(name: string, operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error("experimental persistence requires Web Locks");
  return navigator.locks.request(`kandelo-fixed-rootfs-${name}`, { mode: "exclusive" }, async () => {
    const scope = new ImageManifestMemoryScope(manifestMemory);
    try {
      manifestScopes.set(name, scope);
      return await operation();
    } finally { manifestScopes.delete(name); scope.dispose(); }
  });
}

function runtimeLockName(name: string): string {
  return `kandelo-fixed-rootfs-runtime:${name}`;
}

async function whenRuntimeIdle<T>(name: string, operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error("experimental persistence requires Web Locks");
  return navigator.locks.request(runtimeLockName(name), { mode: "exclusive", ifAvailable: true }, (lock) => {
    if (lock === null) throw new Error("experimental persistence computer is already running in another tab");
    return operation();
  });
}

export async function acquireFixedPersistenceRuntimeLease(name: string): Promise<BrowserPersistenceComputerLease> {
  fileNames(name);
  return acquireBrowserPersistenceComputerLease(name);
}

export async function loadFixedPersistenceImageHandle(
  name: string,
  identity: string,
): Promise<FixedPersistenceImageHandle | null> {
  fileNames(name);
  return locked(name, async () => {
    const parent = await directory(name);
    const selected = await selectSavedImage(parent, name, identity);
    if (selected === null) return null;
    let handle: FixedPersistenceImageHandle | null;
    try { handle = await imageHandleFromSaved(parent, name, selected.saved); }
    catch (error) {
      if (!isImageMetadataDamage(error)) throw error;
      throw new UnprovenImageFreshnessError(undefined, { cause: error });
    }
    if (handle !== null && selected.repair && hasJournalBinding(selected.saved.manifest)) {
      handle.recovery = await recoverySelection(parent, name, selected.saved, selected.choice);
    }
    return handle;
  });
}

export async function loadPreviousFixedPersistenceImageHandle(
  name: string,
  identity: string,
  failed: FixedPersistenceImageHandle,
): Promise<FixedPersistenceImageHandle | null> {
  fileNames(name);
  return locked(name, async () => {
    const parent = await directory(name);
    const active = await readActiveBinding(parent, name, identity);
    if (active?.state.phase !== "prepared" || active.source === null
      || active.record.target.journalName !== failed.journalName
      || active.record.target.imageIdentitySha256 !== failed.imageIdentitySha256
      || active.record.target.generation !== failed.generation) return null;
    const target = await openSavedImage(parent, name, active.target);
    if (!(await target.imageFile.isSameEntry(failed.file))) return null;
    const source = await openSavedImage(parent, name, active.source);
    await verifySavedBinding(parent, source);
    const handle = await imageHandleFromSaved(parent, name, source);
    if (handle !== null) handle.recovery = await recoverySelection(parent, name, source, "source");
    return handle;
  });
}

async function recoverySelection(
  parent: FileSystemDirectoryHandle,
  name: string,
  selected: ImageManifestMetadata,
  choice: "primary" | "target" | "source",
): Promise<NonNullable<FixedPersistenceImageHandle["recovery"]>> {
  const names = fileNames(name);
  return {
    currentManifestSha256: await manifestSha256(parent, names.manifest),
    activeBindingSha256: await manifestSha256(parent, names.binding),
    selectedManifestSha256: (await imageBindingIdentity(name, selected)).digest,
    choice,
  };
}

async function normalizeSavedManifest(
  parent: FileSystemDirectoryHandle,
  name: string,
  identity: string,
  saved: SavedImage,
): Promise<ImageManifest> {
  const handle = await imageHandleFromSaved(parent, name, saved);
  if (handle === null) throw new UnprovenImageFreshnessError("Persistent image has no verified boot metadata");
  return manifestForStagedImage(name, identity, handle, saved.manifest.journalInitialized === true);
}

async function commitImageSelection(
  parent: FileSystemDirectoryHandle,
  name: string,
  identity: string,
  saved: SavedImage,
  assertCurrent?: () => void,
): Promise<void> {
  await verifySavedBinding(parent, saved);
  const names = fileNames(name);
  const manifest = await normalizeSavedManifest(parent, name, identity, saved);
  const metadata = await validateImageManifest(name, identity, manifest);
  const expected = await imageBindingIdentity(name, metadata);
  const primary = await observeImageControl(() => readImageManifestAt(parent, name, identity, names.manifest));
  if (primary.value === null || (await imageBindingIdentity(name, primary.value)).digest !== expected.digest) {
    await writeManifest(parent, names.manifest, manifest, assertCurrent);
  }
  const active = await observeImageControl(() => readActiveBinding(parent, name, identity));
  if (active.value?.state.phase !== "active" || active.value.state.target.digest !== expected.digest) {
    await writeActiveBinding(parent, name, identity, manifest, undefined, assertCurrent);
  }
  const published = await readImageManifestAt(parent, name, identity, names.manifest);
  const confirmed = await readActiveBinding(parent, name, identity);
  if (published === null || (await imageBindingIdentity(name, published)).digest !== expected.digest
    || confirmed?.state.phase !== "active" || confirmed.state.target.digest !== expected.digest) {
    throw new UnprovenImageFreshnessError("Persistent active binding repair was not published");
  }
}

export async function promoteFixedPersistenceRecovery(
  name: string,
  identity: string,
  recovered: FixedPersistenceImageHandle,
  assertCurrent?: () => void,
): Promise<void> {
  const recovery = recovered.recovery;
  if (recovery === undefined) return;
  fileNames(name);
  await locked(name, async () => {
    assertCurrent?.();
    const parent = await directory(name);
    const names = fileNames(name);
    const requested = await manifestForStagedImage(name, identity, recovered, recovered.journalInitialized);
    const expected = await imageBindingIdentity(name, await validateImageManifest(name, identity, requested));
    if (await manifestSha256(parent, names.manifest) !== recovery.currentManifestSha256
      || await manifestSha256(parent, names.binding) !== recovery.activeBindingSha256) {
      const primary = await observeImageControl(() => readImageManifestAt(parent, name, identity, names.manifest));
      const active = await observeImageControl(() => readActiveBinding(parent, name, identity));
      if (primary.value !== null && (await imageBindingIdentity(name, primary.value)).digest === expected.digest
        && active.value?.state.phase === "active" && active.value.state.target.digest === expected.digest) return;
      throw new UnprovenImageFreshnessError("Persistent image bindings changed before recovery");
    }
    let selected: SavedImage;
    if (recovery.choice === "source") {
      const active = await readActiveBinding(parent, name, identity);
      if (active?.state.phase !== "prepared" || active.source === null
        || active.state.source.digest !== recovery.selectedManifestSha256) throw new UnprovenImageFreshnessError();
      selected = await openSavedImage(parent, name, active.source);
    } else {
      const selection = await selectSavedImage(parent, name, identity);
      if (selection === null || (await imageBindingIdentity(name, selection.saved)).digest !== recovery.selectedManifestSha256) {
        throw new UnprovenImageFreshnessError("Persistent selected image changed before recovery");
      }
      selected = selection.saved;
    }
    const normalized = await normalizeSavedManifest(parent, name, identity, selected);
    if ((await imageBindingIdentity(name, await validateImageManifest(name, identity, normalized))).digest !== expected.digest
      || !(await selected.imageFile.isSameEntry(recovered.file))) throw new UnprovenImageFreshnessError();
    await commitImageSelection(parent, name, identity, selected, assertCurrent);
  });
}
async function imageHandleFromSaved(
  parent: FileSystemDirectoryHandle,
  name: string,
  saved: NonNullable<Awaited<ReturnType<typeof readSavedImageAt>>>,
): Promise<FixedPersistenceImageHandle | null> {
  if (saved.composition === undefined || !saved.lazyAssetsRecorded) {
    throw new Error("experimental persistence base image lacks boot metadata; refusing to boot");
  }
  const imageIdentitySha256 = await verifySavedBinding(parent, saved);
  return {
    file: saved.imageFile,
    imageFileName: saved.manifest.imageFileName,
    journalName: saved.manifest.journalName ?? name,
    journalInitialized: !hasJournalBinding(saved.manifest) || saved.manifest.journalInitialized === true,
    imageIdentitySha256,
    length: saved.manifest.length,
    generation: saved.manifest.generation ?? 0,
    payloadLength: saved.manifest.payloadLength,
    integrityPolicy: saved.manifest.integrityPolicy,
    persistentImageBinding: snapshotPersistentImageReadBinding({ identitySha256: imageIdentitySha256, dataCachePages: 0, indexCachePages: 0 }),
    lazyAssets: saved.lazyAssets,
    composition: saved.composition,
  };
}

export async function markFixedPersistenceJournalInitialized(
  name: string,
  identity: string,
  installed: FixedPersistenceImageHandle,
): Promise<void> {
  fileNames(name);
  return locked(name, async () => {
    const parent = await directory(name);
    const names = fileNames(name);
    const selected = await selectSavedImage(parent, name, identity);
    const saved = selected?.saved;
    if (saved === undefined || !hasJournalBinding(saved.manifest)
      || saved.manifest.journalName !== installed.journalName || saved.manifest.length !== installed.length
      || (saved.manifest.generation ?? 0) !== installed.generation
      || !(await saved.imageFile.isSameEntry(installed.file))) {
      throw new Error("experimental persistence image changed before journal initialization");
    }
    if (saved.manifest.journalInitialized) {
      if (selected!.repair) await commitImageSelection(parent, name, identity, saved);
      return;
    }
    await verifyJournalHeader(parent, installed.journalName, saved.manifest.imageIdentitySha256!);
    const handle = await imageHandleFromSaved(parent, name, saved);
    if (handle === null) throw new UnprovenImageFreshnessError();
    const manifest = await manifestForStagedImage(name, identity, handle, true);
    await writeManifest(parent, names.previousManifest, manifest);
    await writeActiveBinding(parent, name, identity, manifest, saved.manifest);
    await writeManifest(parent, names.manifest, manifest);
    await writeActiveBinding(parent, name, identity, manifest);
    const verified = await readImageManifestAt(parent, name, identity, names.manifest);
    const active = await readActiveBinding(parent, name, identity);
    if (verified?.manifest.journalInitialized !== true || active?.state.phase !== "active"
      || (await imageBindingIdentity(name, verified)).digest !== active.state.target.digest) {
      throw new Error("experimental persistence journal initialization was not published");
    }
  });
}
async function verifyJournalHeader(
  parent: FileSystemDirectoryHandle,
  journalName: string,
  imageIdentitySha256: string,
): Promise<void> {
  const matches = async (fileName: string): Promise<boolean> => {
    const file = await existingFile(parent, fileName);
    const journal = file === null ? null : await file.getFile();
    if (journal === null || journal.size < 72) return false;
    const header = new Uint8Array(await journal.slice(0, 72).arrayBuffer());
    return header.byteLength === 72 && new TextDecoder().decode(header.subarray(0, 4)) === "KOVL"
      && new DataView(header.buffer).getUint32(4, true) === 1
      && bytesToHex(header.subarray(8, 40)) === imageIdentitySha256
      && await sha256(header.subarray(0, 40)) === bytesToHex(header.subarray(40, 72));
  };
  if (await matches(journalName + ".journal")) return;
  const prefix = journalName + ".";
  for await (const fileName of parent.keys()) {
    if (!fileName.startsWith(prefix) || !fileName.endsWith(".journal")) continue;
    const slot = fileName.slice(prefix.length, -".journal".length);
    if (parseSealedGenerationSlot(slot) !== null && await matches(fileName)) return;
  }
  throw new Error("experimental persistence journal does not belong to this image or is not initialized");
}
async function writeFixedPersistenceImageStream(
  name: string,
  identity: string,
  source: PersistentImageStream,
  lazyAssets: ImageOwnedRuntimeLazyAssets | undefined,
  composition: StoredComposition,
  assertCurrent?: () => void,
  onProgress?: (message: string, progress?: PersistentImageProgress) => void,
  journalName = name,
  mode: "install" | "replacement" = "install",
  signal?: AbortSignal,
): Promise<FixedPersistenceImageHandle> {
  if (!source || !Number.isSafeInteger(source.payloadLength) || source.payloadLength <= 0
    || (source.integrityPolicy !== "crc32c" && source.integrityPolicy !== "sha256")) {
    throw new Error("experimental persistence image creation requires an explicit length and checking policy");
  }
  fileNames(name);
  if (!browserJournalBelongsToComputer(name, journalName)) {
    throw new Error("experimental persistence journal namespace is invalid");
  }
  onProgress?.("persistent image requesting lock");
  return locked(name, async () => {
    onProgress?.("persistent image lock acquired");
    assertCurrent?.();
    const parent = await directory(name);
    onProgress?.("persistent image directory opened");
    const existing = mode === "install"
      ? await readSavedImage(parent, name, identity)
      : await readSavedImageAt(parent, name, identity, fileNames(name).manifest);
    if (mode === "install" && existing !== null) {
      throw new Error("experimental persistence was initialized concurrently; restart the computer");
    }
    if (mode === "replacement" &&
      (!hasJournalBinding(existing?.manifest) || !existing?.manifest.journalInitialized)) {
      throw new Error("experimental persistence replacement requires a ready current image");
    }
    if (mode === "replacement" && source.integrityPolicy !== existing?.manifest.integrityPolicy) {
      throw new Error("experimental persistence checking policy cannot change during a checkpoint");
    }
    onProgress?.("persistent image absence checked");
    if (mode === "install") {
      const generationPattern = new RegExp(`^${name}\\.[0-9a-f-]{36}\\.base$`);
      const entries = (parent as FileSystemDirectoryHandle & {
        entries(): AsyncIterable<[string, FileSystemHandle]>;
      }).entries();
      for await (const [entryName] of entries) {
        if (generationPattern.test(entryName)) {
          throw new UnprovenImageFreshnessError("Persistent image data exists without its metadata; refusing automatic reinitialization");
        }
      }
    }
    const generation = mode === "install" ? 0 : (existing?.manifest.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new Error("experimental persistence image generations exhausted");
    const imageFileName = `${name}.${crypto.randomUUID()}.base`;
    const imageFile = await parent.getFileHandle(imageFileName, { create: true });
    onProgress?.("persistent image file opened");
    let retained = false;
    try {
      const moduleBytes = await loadPositionedImageWriterModuleBytes();
      const receipt = await runWithPersistentImageProgress(update => writePersistentImageFile(imageFile, moduleBytes,
        source.payloadLength, source.integrityPolicy, source.chunks, {
          signal,
          assertCurrent,
          onProgress: update,
        }), progress => onProgress?.(`persistent image ${progress.phase}: ${progress.status === "error" ? "failed at " : ""}${progress.bytes}/${progress.total}`, progress));
      onProgress?.("persistent image readback verified");
      const result: FixedPersistenceImageHandle = {
        file: imageFile,
        imageFileName,
        journalName,
        journalInitialized: false,
        imageIdentitySha256: receipt.identitySha256,
        length: receipt.physicalLength,
        payloadLength: receipt.payloadLength,
        integrityPolicy: receipt.integrityPolicy,
        generation,
        persistentImageBinding: snapshotPersistentImageReadBinding({
          identitySha256: receipt.identitySha256, dataCachePages: 0, indexCachePages: 0,
        }),
        lazyAssets,
        composition,
      };
      if (mode === "install") {
        await publishImage(parent, name, identity, result, () => { retained = true; }, assertCurrent);
      }
      retained = true;
      return result;
    } catch (error) {
      if (error instanceof UnprovenImageCodecCleanupError) retained = true;
      throw error;
    } finally {
      if (!retained) await parent.removeEntry(imageFileName).catch(() => {});
    }
  });
}

async function publishImage(
  parent: FileSystemDirectoryHandle,
  name: string,
  identity: string,
  staged: FixedPersistenceImageHandle,
  retainStagedImage: () => void,
  assertCurrent?: () => void,
): Promise<void> {
  const names = fileNames(name);
  if (await readSavedImage(parent, name, identity) !== null) {
    throw new Error("experimental persistence was initialized concurrently; restart the computer");
  }
  const manifest = await manifestForStagedImage(name, identity, staged, false);
  const contents = encodeManifestValue(name, manifest);
  assertCurrent?.();
  retainStagedImage();
  try {
    await writeManifest(parent, names.manifest, manifest, assertCurrent);
  } catch (error) {
    const file = await existingFile(parent, names.manifest).catch(() => null);
    let stored: string | null = null;
    try { if (file !== null) stored = await readManifestText(file, name); } catch {}
    if (stored !== null && stored !== contents) await parent.removeEntry(names.manifest).catch(() => {});
    throw error;
  }
  await writeActiveBinding(parent, name, identity, manifest, undefined, assertCurrent);
}
async function manifestForStagedImage(
  name: string,
  identity: string,
  staged: FixedPersistenceImageHandle,
  journalInitialized: boolean,
): Promise<ImageManifest> {
  const imageFileName = staged.imageFileName;
  if (
    imageFileName === undefined ||
    !new RegExp(`^${name}\\.[0-9a-f-]{36}\\.base$`).test(imageFileName) ||
    !SHA256_PATTERN.test(staged.imageIdentitySha256 ?? "") ||
    !Number.isSafeInteger(staged.length) || staged.length <= 0 ||
    !Number.isSafeInteger(staged.generation) || staged.generation < 0 ||
    !Number.isSafeInteger(staged.payloadLength) || staged.payloadLength <= 0 || staged.payloadLength >= staged.length ||
    (staged.integrityPolicy !== "crc32c" && staged.integrityPolicy !== "sha256") ||
    snapshotPersistentImageReadBinding(staged.persistentImageBinding).identitySha256 !== staged.imageIdentitySha256
  ) {
    throw new Error("experimental persistence staged image is invalid");
  }
  const savedLazyAssets = parseLazyAssets(staged.lazyAssets) ?? null;
  const savedComposition = parseComposition(staged.composition, name);
  const manifest: ImageManifest = {
    format: FORMAT_V6,
    imageFormat: IMAGE_FORMAT,
    payloadLength: staged.payloadLength,
    integrityPolicy: staged.integrityPolicy,
    identity,
    imageFileName,
    journalName: staged.journalName,
    journalInitialized,
    imageIdentitySha256: staged.imageIdentitySha256,
    generation: staged.generation,
    journalNameSha256: await sha256(new TextEncoder().encode(encodeManifestValue(name, [
      identity, imageFileName, staged.journalName, journalInitialized, staged.generation,
    ]))),
    length: staged.length,
    lazyAssets: savedLazyAssets,
    lazyAssetsSha256: await sha256(new TextEncoder().encode(encodeManifestValue(name, savedLazyAssets))),
    composition: savedComposition,
    compositionSha256: await sha256(new TextEncoder().encode(encodeManifestValue(name, savedComposition))),
  };
  return manifest;
}

async function writeManifest(
  parent: FileSystemDirectoryHandle,
  fileName: string,
  manifest: ImageManifest | ActiveImageBinding,
  assertCurrent?: () => void,
): Promise<void> {
  const name = /^([a-zA-Z0-9_-]{1,128})(?:\.previous|\.active)?\.base\.json$/.exec(fileName)?.[1];
  if (name === undefined) throw new Error("Invalid image manifest publication name");
  const contents = encodeManifestValue(name, manifest);
  const file = await parent.getFileHandle(fileName, { create: true });
  const writer = await file.createWritable();
  let closeAttempted = false;
  try {
    await writer.write(contents);
    assertCurrent?.();
    closeAttempted = true;
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    if (closeAttempted && await readManifestText(file, name).catch(() => null) === contents) {
      return;
    }
    throw error;
  }
}

export async function stageFixedPersistenceReplacement(
  name: string,
  identity: string,
  source: PersistentImageStream,
  lazyAssets: ImageOwnedRuntimeLazyAssets | undefined,
  composition: StoredComposition,
  assertCurrent?: () => void,
): Promise<FixedPersistenceImageHandle> {
  return writeFixedPersistenceImageStream(
    name, identity, source, lazyAssets, composition, assertCurrent, undefined,
    browserReplacementJournalName(name), "replacement",
  );
}

export async function publishFixedPersistenceReplacement(
  name: string,
  identity: string,
  previous: FixedPersistenceImageHandle,
  staged: FixedPersistenceImageHandle,
  assertCurrent?: () => void,
  persistenceComputerLease?: BrowserPersistenceComputerLease,
  journalLeases?: { source: BrowserPersistenceJournalLease; target: BrowserPersistenceJournalLease },
): Promise<void> {
  fileNames(name);
  if (staged.journalName === previous.journalName ||
    staged.journalName === name || !browserJournalBelongsToComputer(name, staged.journalName)) {
    throw new Error("experimental persistence replacement source changed");
  }
  const publish = () => locked(name, async () => {
      assertCurrent?.();
      const parent = await directory(name);
      const names = fileNames(name);
      const current = (await selectSavedImage(parent, name, identity))?.saved ?? null;
      const manifest = await manifestForStagedImage(name, identity, staged, true);
      const attempt = snapshotPublications.get(staged);
      if (attempt !== undefined) {
        const active = await readActiveBinding(parent, name, identity);
        const targetDigest = (await imageBindingIdentity(name, await validateImageManifest(name, identity, manifest))).digest;
        const alreadyActive = active?.state.phase === "active" && active.state.target.digest === targetDigest;
        const source = active?.state.phase === "prepared" && active.state.target.digest === targetDigest
          ? active.state.source : current === null ? null : await imageBindingIdentity(name, current);
        if (targetDigest !== attempt.targetDigest || (!alreadyActive && (
          journalLeases?.source !== attempt.source || journalLeases?.target !== attempt.target
          || attempt.target === null || source?.content !== attempt.sourceContent || source.generation !== attempt.sourceGeneration
        ))) throw new UnprovenImageFreshnessError("Checkpoint snapshot ownership changed; create a new snapshot");
      }
      if (current?.manifest.format === FORMAT_V6 && encodeManifestValue(name, current.manifest) === encodeManifestValue(name, manifest) &&
        await current.imageFile.isSameEntry(staged.file)) {
        const backup = await readSavedImageAt(parent, name, identity, names.previousManifest);
        if (backup?.manifest.format !== FORMAT_V6 || !backup.manifest.journalInitialized ||
          backup.manifest.journalName !== previous.journalName ||
          backup.manifest.imageIdentitySha256 !== previous.imageIdentitySha256 ||
          backup.manifest.length !== previous.length ||
          backup.manifest.payloadLength !== previous.payloadLength ||
          backup.manifest.integrityPolicy !== previous.integrityPolicy ||
          (backup.manifest.generation ?? 0) !== previous.generation ||
          encodeManifestValue(name, backup.composition) !== encodeManifestValue(name, previous.composition) ||
          encodeManifestValue(name, backup.manifest.lazyAssets) !== encodeManifestValue(name, previous.lazyAssets ?? null) ||
          !(await backup.imageFile.isSameEntry(previous.file))) {
          throw new Error("experimental persistence previous generation was not preserved");
        }
        await verifySavedBinding(parent, backup);
        await verifySavedBinding(parent, current);
        await commitImageSelection(parent, name, identity, current, assertCurrent);
        return;
      }
      if (
        !hasJournalBinding(current?.manifest) || !current?.manifest.journalInitialized ||
        current.manifest.journalName !== previous.journalName ||
        current.manifest.imageIdentitySha256 !== previous.imageIdentitySha256 ||
        current.manifest.length !== previous.length ||
        current.manifest.payloadLength !== previous.payloadLength ||
        current.manifest.integrityPolicy !== previous.integrityPolicy || staged.integrityPolicy !== previous.integrityPolicy ||
        (current.manifest.generation ?? 0) !== previous.generation || staged.generation !== previous.generation + 1 ||
        encodeManifestValue(name, current.composition) !== encodeManifestValue(name, previous.composition) ||
        encodeManifestValue(name, current.manifest.lazyAssets) !== encodeManifestValue(name, previous.lazyAssets ?? null) ||
        !(await current.imageFile.isSameEntry(previous.file))
      ) {
        throw new Error("experimental persistence replacement source changed");
      }
      await verifySavedBinding(parent, current);
      const stagedFile = await existingFile(parent, manifest.imageFileName!);
      if (stagedFile === null || !(await stagedFile.isSameEntry(staged.file))) {
        throw new Error("experimental persistence staged image changed");
      }
      const snapshot = await stagedFile.getFile();
      if (snapshot.size !== staged.length) {
        throw new Error("experimental persistence staged image is damaged");
      }
      const geometry = await inspectPersistentImageFile(stagedFile, await loadPositionedImageWriterModuleBytes(),
        staged.length, staged.imageIdentitySha256!, staged.integrityPolicy, { assertCurrent });
      if (geometry.payloadLength !== staged.payloadLength) throw new Error("experimental persistence staged image geometry is damaged");
      await verifyJournalHeader(parent, staged.journalName, staged.imageIdentitySha256!);
      assertCurrent?.();
      const fallbackHandle = await imageHandleFromSaved(parent, name, current);
      if (fallbackHandle === null) throw new Error("experimental persistence previous generation lacks boot metadata");
      const fallback = await manifestForStagedImage(name, identity, fallbackHandle, true);
      await writeManifest(parent, names.previousManifest, fallback, assertCurrent);
      const backup = await readSavedImageAt(parent, name, identity, names.previousManifest);
      if (backup === null || backup.manifest.imageFileName !== current.manifest.imageFileName ||
        backup.manifest.journalName !== current.manifest.journalName ||
        backup.manifest.journalInitialized !== true) {
        throw new Error("experimental persistence previous generation was not preserved");
      }
      assertCurrent?.();
      await commitImageSelection(parent, name, identity, current, assertCurrent);
      await writeActiveBinding(parent, name, identity, manifest, fallback, assertCurrent);
      await writeManifest(parent, names.manifest, manifest, assertCurrent);
      await writeActiveBinding(parent, name, identity, manifest, undefined, assertCurrent);
      const published = await readSavedImageAt(parent, name, identity, names.manifest);
      if (published === null || published.manifest.imageFileName !== manifest.imageFileName ||
        published.manifest.journalName !== staged.journalName ||
        published.manifest.journalInitialized !== true) {
        throw new Error("experimental persistence replacement was not published");
      }
      const active = await readActiveBinding(parent, name, identity);
      if (active?.state.phase !== "active" || active.state.target.digest !== (await imageBindingIdentity(name, published)).digest) {
        throw new UnprovenImageFreshnessError("Persistent replacement active binding was not published");
      }
    });
  const withJournalLocks = () => journalLeases === undefined
    ? withIdleBrowserPersistenceJournals(previous.journalName, staged.journalName, publish)
    : withHeldBrowserPersistenceJournals(
      journalLeases.source, journalLeases.target,
      previous.journalName, staged.journalName, publish,
    );
  if (persistenceComputerLease !== undefined) {
    await withHeldBrowserPersistenceComputerLease(persistenceComputerLease, name, withJournalLocks);
  } else {
    await whenRuntimeIdle(name, withJournalLocks);
  }
}

export async function discardFixedPersistenceStagedReplacement(
  name: string,
  identity: string,
  staged: FixedPersistenceImageHandle,
): Promise<boolean> {
  fileNames(name);
  if (staged.journalName === name || !browserJournalBelongsToComputer(name, staged.journalName)) {
    throw new Error("experimental persistence staged journal namespace is invalid");
  }
  return whenRuntimeIdle(name, () => navigator.locks.request(
    browserPersistenceJournalLockName(staged.journalName),
    { mode: "exclusive", ifAvailable: true },
    (journalLock) => {
      if (journalLock === null) throw new Error("experimental persistence journal is already open");
      return locked(name, async () => {
        const stagedManifest = await manifestForStagedImage(name, identity, staged, true);
        const parent = await directory(name);
        const names = fileNames(name);
        const current = await readSavedImageAt(parent, name, identity, names.manifest);
        const previous = await readSavedImageAt(parent, name, identity, names.previousManifest);
        const active = await readActiveBinding(parent, name, identity);
        if ([current?.manifest, previous?.manifest, active?.record.target, active?.record.source].some((manifest) => manifest !== undefined && (
          manifest.imageFileName === stagedManifest.imageFileName ||
          manifest.journalName === staged.journalName
        ))) return false;
        const image = await existingFile(parent, stagedManifest.imageFileName!);
        if (image !== null && !(await image.isSameEntry(staged.file))) {
          throw new Error("experimental persistence staged image changed before discard");
        }
        const remove = async (file: string) => parent.removeEntry(file).catch((error) => {
          if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
        });
        for (const suffix of ["journal", "index", "seal", "activation0", "activation1"]) await remove(`${staged.journalName}.${suffix}`);
        const prefix = `${staged.journalName}.`;
        for await (const filename of parent.keys()) {
          if (filename.startsWith(prefix)
            && /^g[0-9]+\.(?:journal|index|seal)$/.test(filename.slice(prefix.length))) {
            await remove(filename);
          }
        }
        if (image !== null) await parent.removeEntry(stagedManifest.imageFileName!);
        return true;
      });
    },
  ));
}

export async function saveFixedPersistenceImageStream(
  name: string,
  identity: string,
  source: PersistentImageStream,
  lazyAssets: ImageOwnedRuntimeLazyAssets | undefined,
  composition: StoredComposition,
  assertCurrent?: () => void,
  onProgress?: (message: string, progress?: PersistentImageProgress) => void,
  journalName?: string,
  signal?: AbortSignal,
): Promise<FixedPersistenceImageHandle> {
  const checkCurrent = () => { signal?.throwIfAborted(); assertCurrent?.(); };
  return writeFixedPersistenceImageStream(
    name, identity, source, lazyAssets, composition, checkCurrent, onProgress, journalName, "install", signal,
  );
}

export async function publishFixedPersistenceSnapshot(
  name: string,
  identity: string,
  stagedFile: FileSystemFileHandle,
  integrity: OpfsImageIntegrity,
  lazyAssets: ImageOwnedRuntimeLazyAssets | undefined,
  composition: StoredComposition,
  integrityPolicy: PersistentImageIntegrityPolicy,
  assertCurrent?: () => void,
): Promise<FixedPersistenceImageHandle> {
  return saveFixedPersistenceImageStream(
    name, identity, { chunks: await verifiedSnapshotChunks(stagedFile, integrity, assertCurrent), payloadLength: integrity.length, integrityPolicy },
    lazyAssets, composition, assertCurrent,
  );
}

export async function stageFixedPersistenceReplacementFromFile(
  name: string,
  identity: string,
  stagedFile: FileSystemFileHandle,
  integrity: OpfsImageIntegrity,
  lazyAssets: ImageOwnedRuntimeLazyAssets | undefined,
  composition: StoredComposition,
  integrityPolicy: PersistentImageIntegrityPolicy,
  assertCurrent?: () => void,
): Promise<FixedPersistenceImageHandle> {
  return stageFixedPersistenceReplacement(
    name, identity, { chunks: await verifiedSnapshotChunks(stagedFile, integrity, assertCurrent), payloadLength: integrity.length, integrityPolicy },
    lazyAssets, composition, assertCurrent,
  );
}

export async function stageFixedPersistenceSnapshotReplacement(
  name: string,
  identity: string,
  stagedFile: FileSystemFileHandle,
  integrity: OpfsImageIntegrity,
  lazyAssets: ImageOwnedRuntimeLazyAssets | undefined,
  composition: StoredComposition,
  assertCurrent: (() => void) | undefined,
  sourceJournalLease: BrowserPersistenceJournalLease,
  integrityPolicy: PersistentImageIntegrityPolicy,
): Promise<FixedPersistenceImageHandle> {
  return withHeldBrowserPersistenceJournal(sourceJournalLease, sourceJournalLease.journalName, async () => {
    const source = await locked(name, async () => {
      const saved = await readSavedImage(await directory(name), name, identity);
      if (saved === null || !saved.manifest.journalInitialized || saved.manifest.journalName !== sourceJournalLease.journalName) {
        throw new UnprovenImageFreshnessError("Checkpoint source ownership does not match the saved image");
      }
      return imageBindingIdentity(name, saved);
    });
    const staged = await stageFixedPersistenceReplacementFromFile(
      name, identity, stagedFile, integrity, lazyAssets, composition, integrityPolicy, assertCurrent,
    );
    try {
      const targetDigest = await locked(name, async () => (await imageBindingIdentity(name,
        await validateImageManifest(name, identity, await manifestForStagedImage(name, identity, staged, true)))).digest);
      snapshotPublications.set(staged, { source: sourceJournalLease, target: null,
        sourceContent: source.content, sourceGeneration: source.generation, targetDigest });
      return staged;
    } catch (error) {
      try { await (await directory(name)).removeEntry(staged.imageFileName!); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Checkpoint attempt creation and stage cleanup failed"); }
      throw error;
    }
  });
}

export async function authorizeFixedPersistenceSnapshotPublication(
  staged: FixedPersistenceImageHandle,
  source: BrowserPersistenceJournalLease,
  target: BrowserPersistenceJournalLease,
): Promise<void> {
  const attempt = snapshotPublications.get(staged);
  if (attempt === undefined || attempt.source !== source || (attempt.target !== null && attempt.target !== target)) {
    throw new UnprovenImageFreshnessError("Checkpoint snapshot ownership changed; create a new snapshot");
  }
  await withHeldBrowserPersistenceJournals(source, target, source.journalName, staged.journalName, async () => {
    attempt.target = target;
  });
}

async function verifiedSnapshotChunks(
  stagedFile: FileSystemFileHandle,
  integrity: OpfsImageIntegrity,
  assertCurrent?: () => void,
): Promise<AsyncIterable<Uint8Array>> {
  if (
    !isStagedRootfsImageIntegrity(integrity)
  ) {
    throw new Error("experimental persistence snapshot integrity is invalid");
  }
  const snapshot = await stagedFile.getFile();
  if (snapshot.size !== integrity.length) {
    throw new Error("experimental persistence snapshot length is invalid");
  }
  async function* verifiedChunks(): AsyncIterable<Uint8Array> {
    const imageHash = incrementalSha256.create();
    for (let offset = 0; offset < integrity.length; offset += CHUNK_BYTES) {
      assertCurrent?.();
      const bytes = new Uint8Array(await snapshot.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
      if (bytes.byteLength !== Math.min(CHUNK_BYTES, integrity.length - offset) ||
        (integrity.chunkSha256 !== undefined && await sha256(bytes) !== integrity.chunkSha256[offset / CHUNK_BYTES])) {
        throw new Error("experimental persistence snapshot is damaged; refusing to publish");
      }
      imageHash.update(bytes);
      yield bytes;
    }
    if (integrity.imageSha256 !== undefined && bytesToHex(imageHash.digest()) !== integrity.imageSha256) {
      throw new Error("experimental persistence snapshot is damaged; refusing to publish");
    }
  }
  return verifiedChunks();
}
