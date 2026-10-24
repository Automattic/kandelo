import { ERRNO } from "../generated/abi";
import { digestOverlayStoragePrefix, parseSealedGenerationSlot, verifyOverlayGenerationSeal, verifyOverlayGenerationSealSync, writeOverlayGenerationSealSync, type OverlaySealSource } from "./overlay-generation-seal";
import { InvalidOverlaySealError, type OverlayRecoveryEvidence, type OverlaySealCodec } from "./overlay-seal-codec";
import type { PersistentOverlayStorage } from "./overlay-storage";
import { retainOverlayGenerationCleanup, withOverlayGenerationMetadata, type OverlayGenerationMetadata, type OverlayGenerationMetadataScope } from "./overlay-generation-metadata";
import { InvalidOverlayActivationError, OverlayActivationControlPair, UnconfirmedOverlayActivationError, UnprovenOverlayActivationCleanupError, type OverlayActivationRecord, type OverlayActivationCodec } from "./overlay-generation-activation";

export class RejectedOverlayGenerationError extends Error {
  constructor(readonly mode: "fixed" | "resizable", readonly errno: number, readonly pristineRecovery = false) {
    super(`kernel refused ${mode} rootfs persistence (errno ${errno})`);
  }
}

class RejectedConvertedTargetError extends Error {
  constructor(readonly cause: RejectedOverlayGenerationError) {
    super(cause.message);
  }
}

function isStorageQuotaError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOSPC";
}

export class NoValidOverlayGenerationError extends Error {
  readonly recovery = "no-valid-overlay-generation" as const;

  constructor(options?: ErrorOptions) {
    super("persistent overlay has no valid journal generation; refusing to reset the computer", options);
    this.name = "NoValidOverlayGenerationError";
  }
}

export function isNoValidOverlayGenerationError(error: unknown): error is NoValidOverlayGenerationError {
  return error instanceof Error &&
    "recovery" in error && error.recovery === "no-valid-overlay-generation";
}

const COMPACTION_SLOTS = ["g0", "g1", "g2"] as const;
const INITIAL_GENERATION_SLOTS = [...COMPACTION_SLOTS, "g3"] as const;

export type OverlayGenerationSlot = "legacy" | `g${number}`;
export type OverlayGenerationFile = "journal" | "seal" | "index" | "activation0" | "activation1";

export interface OverlayGenerationFiles {
  readonly activationCodec: OverlayActivationCodec;
  readonly sealCodec: OverlaySealCodec;
  readonly metadata?: OverlayGenerationMetadata;
  listSlots(): Promise<Iterable<string>> | Iterable<string> | AsyncIterable<string>;
  open(
    slot: OverlayGenerationSlot,
    file: OverlayGenerationFile,
    create: boolean,
  ): Promise<PersistentOverlayStorage | null>;
  remove(slot: OverlayGenerationSlot, file: OverlayGenerationFile): Promise<void>;
}

interface Candidate {
  journal: PersistentOverlayStorage;
  index?: PersistentOverlayStorage;
  generation: number;
  sealedLength: number;
  slot: SealedGenerationSlot;
  source?: OverlaySealSource;
  activation: Omit<OverlayActivationRecord, "sequence">;
}

type SealedGenerationSlot = `g${number}`;

function nativeGenerationPolicy<Result>(operation: () => Result): Result {
  try { return operation(); }
  catch (error) {
    if (error instanceof InvalidOverlayActivationError) throw new NoValidOverlayGenerationError({ cause: error });
    throw error;
  }
}

async function openActivationControls(files: OverlayGenerationFiles): Promise<OverlayActivationControlPair> {
  try {
    return await OverlayActivationControlPair.open({
      activationCodec: files.activationCodec,
      open: (replica, create) => files.open("legacy", replica === 0 ? "activation0" : "activation1", create),
    });
  } catch (error) {
    if (error instanceof UnprovenOverlayActivationCleanupError) retainOverlayGenerationCleanup(files, error, error);
    if (error instanceof InvalidOverlayActivationError) throw new NoValidOverlayGenerationError({ cause: error });
    throw error;
  }
}

function journalBaseDigest(codec: OverlaySealCodec, journal: PersistentOverlayStorage): Uint8Array {
  const header = new Uint8Array(codec.journalHeaderLength());
  if (journal.len() < header.length) throw new NoValidOverlayGenerationError();
  journal.readExactAt(0, header);
  try { return codec.journalBaseDigest(header); }
  catch (error) {
    if (error instanceof InvalidOverlaySealError) throw new NoValidOverlayGenerationError({ cause: error });
    throw error;
  }
}

function indexRequiresConversion(codec: OverlaySealCodec, index: PersistentOverlayStorage): boolean {
  const header = new Uint8Array(codec.indexHeaderLength());
  if (index.len() < header.length) throw new NoValidOverlayGenerationError();
  index.readExactAt(0, header);
  try { return codec.indexRequiresConversion(header); }
  catch (error) {
    if (error instanceof InvalidOverlaySealError) throw new NoValidOverlayGenerationError({ cause: error });
    throw error;
  }
}

function generationActivationIdentity(
  codec: OverlaySealCodec,
  selected: Pick<SelectedOverlayGeneration, "journal" | "slot" | "generation">,
  seal?: PersistentOverlayStorage,
  baseDigest?: Uint8Array,
): Omit<OverlayActivationRecord, "sequence"> {
  if (baseDigest === undefined) {
    baseDigest = journalBaseDigest(codec, selected.journal);
  }
  if (selected.slot !== "legacy" && seal === undefined) throw new NoValidOverlayGenerationError();
  return {
    slot: selected.slot, generation: selected.generation, baseDigest,
    sealDigest: seal === undefined ? new Uint8Array(32) : digestOverlayStoragePrefix(codec, seal, seal.len()),
  };
}

async function selectedActivationIdentity(
  selected: SelectedOverlayGeneration,
  files: OverlayGenerationFiles,
): Promise<Omit<OverlayActivationRecord, "sequence"> > {
  if (selected.activation !== undefined) return selected.activation;
  if (selected.slot === "legacy") return generationActivationIdentity(files.sealCodec, selected);
  const seal = await files.open(selected.slot, "seal", false);
  if (seal === null) throw new NoValidOverlayGenerationError();
  try {
    const verified = await verifyOverlayGenerationSeal(files.sealCodec, selected.journal, seal, undefined, true, selected.index);
    return generationActivationIdentity(files.sealCodec, selected, seal, verified.baseDigest);
  }
  finally { seal.close(); }
}

function closeActivationControls(
  controls: OverlayActivationControlPair,
  files: OverlayGenerationFiles,
  reportCleanupFailure: (error: unknown) => void,
): void {
  try { controls.close(); }
  catch (error) {
    retainOverlayGenerationCleanup(files, controls, error);
    try { reportCleanupFailure(error); }
    catch (reportError) { console.error("persistent overlay activation cleanup report failed", error, reportError); }
  }
}

async function generationSlots(
  files: OverlayGenerationFiles,
  scope: OverlayGenerationMetadataScope,
): Promise<{ slots: SealedGenerationSlot[]; discovered: Iterable<SealedGenerationSlot> }> {
  for (const slot of INITIAL_GENERATION_SLOTS) scope.retainSlot(slot);
  const slots = new Set<SealedGenerationSlot>(INITIAL_GENERATION_SLOTS);
  const discovered = new Set<SealedGenerationSlot>();
  for await (const name of await files.listSlots()) {
    const slot = parseSealedGenerationSlot(name);
    if (slot === null) throw new Error("persistent overlay generation slot is invalid");
    scope.retainSlot(slot);
    slots.add(slot);
    discovered.add(slot);
  }
  return { slots: [...slots].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1))), discovered };
}

function conversionTarget(
  files: OverlayGenerationFiles,
  source: GenerationLineage,
  slots: readonly SealedGenerationSlot[],
  knownGenerations: ReadonlyMap<SealedGenerationSlot, number>,
  reusable: SealedGenerationSlot | undefined,
): SealedGenerationSlot {
  if (reusable !== undefined && mayUseGenerationTarget(files, source, reusable)) return reusable;
  const vacant = slots.find((slot) => (knownGenerations.get(slot) ?? 0) === 0 && mayUseGenerationTarget(files, source, slot));
  if (vacant !== undefined) return vacant;
  let next = Number(slots[slots.length - 1]!.slice(1)) + 1;
  for (let attempt = 0; attempt < 3; attempt++, next++) {
    if (!Number.isSafeInteger(next + 1)) throw new Error("persistent overlay generation slots exhausted");
    const slot: SealedGenerationSlot = `g${next}`;
    if (mayUseGenerationTarget(files, source, slot)) return slot;
  }
  throw new NoValidOverlayGenerationError();
}

function closeCandidate(candidate: Candidate): void {
  const failures: unknown[] = [];
  for (const storage of [candidate.index, candidate.journal]) {
    try {
      storage?.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "persistent overlay generation cleanup failed");
  }
}

export interface SelectedOverlayGeneration {
  journal: PersistentOverlayStorage;
  index?: PersistentOverlayStorage;
  slot: OverlayGenerationSlot;
  generation: number;
  sealedLength: number;
  reusableSlots?: ReadonlyMap<number, SealedGenerationSlot>;
  knownGenerations?: ReadonlyMap<SealedGenerationSlot, number>;
  convertedFrom?: Pick<SelectedOverlayGeneration, "slot" | "generation">;
  source?: OverlaySealSource;
  activation?: Omit<OverlayActivationRecord, "sequence">;
}

function withKnownGenerations(
  selected: SelectedOverlayGeneration,
  knownGenerations: ReadonlyMap<SealedGenerationSlot, number>,
): SelectedOverlayGeneration {
  const known = new Map(knownGenerations);
  if (selected.slot !== "legacy") known.set(selected.slot, selected.generation);
  return { ...selected, knownGenerations: known };
}

function withReusableSlots(
  selected: SelectedOverlayGeneration,
  reusableSlots: ReadonlyMap<number, SealedGenerationSlot>,
  codec: OverlayActivationCodec,
): SelectedOverlayGeneration {
  const remaining = new Map([...reusableSlots].filter(([generation, slot]) =>
    nativeGenerationPolicy(() => codec.mayReuse(selected, { generation, slot }))));
  return remaining.size === 0 ? selected : { ...selected, reusableSlots: remaining };
}

type GenerationLineage = Pick<SelectedOverlayGeneration, "slot" | "generation" | "knownGenerations" | "convertedFrom" | "source">;

function mayUseGenerationTarget(files: OverlayGenerationFiles, source: GenerationLineage, slot: SealedGenerationSlot): boolean {
  const protectedSource = source.convertedFrom ?? (source.source === undefined ? null : {
    slot: source.source.slot, generation: source.knownGenerations?.get(source.source.slot as SealedGenerationSlot) ?? 0,
  });
  const target = { slot, generation: source.knownGenerations?.get(slot) ?? 0 };
  return nativeGenerationPolicy(() => files.activationCodec.mayStage(source, protectedSource, target));
}

function assertGenerationTarget(files: OverlayGenerationFiles, source: GenerationLineage, slot: SealedGenerationSlot): void {
  if (!mayUseGenerationTarget(files, source, slot)) throw new NoValidOverlayGenerationError();
}

async function retireGeneration(files: OverlayGenerationFiles, slot: SealedGenerationSlot): Promise<void> {
  const seal = await files.open(slot, "seal", false);
  if (seal !== null) {
    let failure: unknown;
    try {
      seal.truncate(0);
      seal.flush();
    } catch (error) {
      failure = error;
    }
    try {
      seal.close();
    } catch (error) {
      failure = failure === undefined ? error
        : new AggregateError([failure, error], "persistent overlay generation retirement failed");
    }
    if (failure !== undefined) throw failure;
  }
  await files.remove(slot, "index");
  await files.remove(slot, "journal");
  await files.remove(slot, "seal");
}

async function retireLegacySource(
  active: SelectedOverlayGeneration,
  source: SelectedOverlayGeneration,
  files: OverlayGenerationFiles,
  reportCleanupFailure: (error: unknown) => void,
): Promise<void> {
  const provenance = source.source;
  if (provenance === undefined || !nativeGenerationPolicy(() => files.activationCodec.mayRetireUnsealed(
    active, source, provenance.slot, provenance.journalDigest !== undefined,
  ))) return;
  try {
    const legacy = await files.open("legacy", "journal", false);
    if (legacy === null) return;
    try {
      if (legacy.len() === 0) return;
      const evidence = { source: "unsealed" as const, expectedLength: provenance.journalLength,
        observedLength: legacy.len(), hasDigest: true };
      if (files.sealCodec.classifySource(evidence) !== "verify-digest") return;
      const digest = digestOverlayStoragePrefix(files.sealCodec, legacy, legacy.len());
      if (files.sealCodec.classifySource({ ...evidence,
        digestMatches: provenance.journalDigest!.every((byte, index) => byte === digest[index]) }) !== "eligible") return;
      legacy.truncate(0);
      legacy.flush();
    } finally {
      legacy.close();
    }
    await files.remove("legacy", "journal");
  } catch (error) {
    try {
      reportCleanupFailure(error);
    } catch (reportError) {
      console.error("persistent overlay legacy retirement cleanup report failed", error, reportError);
    }
  }
}

async function collectObsoleteGenerations(
  active: SelectedOverlayGeneration,
  source: Pick<SelectedOverlayGeneration, "slot" | "generation">,
  files: OverlayGenerationFiles,
  reportCleanupFailure: (error: unknown) => void,
  authority: OverlayActivationRecord | null,
  identity: Omit<OverlayActivationRecord, "sequence">,
): Promise<SelectedOverlayGeneration> {
  const known = new Map(active.knownGenerations);
  if (![...known.keys()].some((slot) => Number(slot.slice(1)) >= 3)) return active;
  for (const [slot, generation] of known) {
    const candidate = { slot, generation };
    if (!nativeGenerationPolicy(() => files.activationCodec.mayRetire(active, source, candidate))
      && !nativeGenerationPolicy(() => files.activationCodec.mayReclaimUnpublished(authority, identity, source, candidate))) continue;
    try {
      await retireGeneration(files, slot);
      known.delete(slot);
    } catch (error) {
      try {
        reportCleanupFailure(error);
      } catch (reportError) {
        console.error("persistent overlay retirement cleanup report failed", error, reportError);
      }
    }
  }
  return { ...active, knownGenerations: known };
}

export async function collectBootOverlayGenerations(
  selected: SelectedOverlayGeneration,
  files: OverlayGenerationFiles,
  reportCleanupFailure: (error: unknown) => void = console.error,
): Promise<SelectedOverlayGeneration> {
  return withOverlayGenerationMetadata(files, async scope => {
    for (const slot of selected.knownGenerations?.keys() ?? []) scope.retainSlot(slot);
    if (selected.slot !== "legacy") scope.retainSlot(selected.slot);
    return collectBootOverlayGenerationsInner(selected, files, reportCleanupFailure);
  });
}

async function collectBootOverlayGenerationsInner(
  selected: SelectedOverlayGeneration,
  files: OverlayGenerationFiles,
  reportCleanupFailure: (error: unknown) => void,
): Promise<SelectedOverlayGeneration> {
  if (selected.slot === "legacy") return selected;
  const verifiedSource = selected.source;
  let source: Pick<SelectedOverlayGeneration, "slot" | "generation"> | undefined;
  if (selected.convertedFrom !== undefined && selected.convertedFrom.slot !== "legacy") {
    source = selected.convertedFrom;
  } else if (verifiedSource !== undefined && verifiedSource.slot !== "legacy") {
    const observed = { slot: verifiedSource.slot, generation: selected.knownGenerations?.get(verifiedSource.slot) ?? 0 };
    if (nativeGenerationPolicy(() => files.activationCodec.relationship(selected, verifiedSource.slot, observed)) === "predecessor") source = observed;
  }
  let active = selected;
  const controls = source === undefined ? null : await openActivationControls(files);
  try {
    if (source !== undefined && controls !== null) {
      const authority = controls.current;
      if (authority !== null) {
        const identity = await selectedActivationIdentity(selected, files);
        nativeGenerationPolicy(() => files.activationCodec.requireInventory(authority, identity, false));
        active = await collectObsoleteGenerations({ ...selected, activation: identity }, source, files, reportCleanupFailure, authority, identity);
      }
    }
    try {
      const legacy = await files.open("legacy", "journal", false);
      if (legacy !== null) {
        let empty = false;
        try {
          empty = legacy.len() === 0;
        } finally {
          legacy.close();
        }
        if (empty) await files.remove("legacy", "journal");
      }
    } catch (error) {
      try {
        reportCleanupFailure(error);
      } catch (reportError) {
        console.error("persistent overlay legacy cleanup report failed", error, reportError);
      }
    }
    return active;
  } finally {
    if (controls !== null) closeActivationControls(controls, files, reportCleanupFailure);
  }
}

export interface OverlayCompactionHandoff {
  prepare(target: PersistentOverlayStorage): void;
  checkpoint(index: PersistentOverlayStorage): void;
  activate(): void;
  cancel(): void;
  fail(error: UnconfirmedOverlayActivationError): void;
  memoryPressure?(): boolean;
}

async function convertOverlayGeneration(
  files: OverlayGenerationFiles,
  source: PersistentOverlayStorage,
  sourceSlot: OverlayGenerationSlot,
  targetSlot: SealedGenerationSlot,
  sourceGeneration: number,
  enable: (journal: PersistentOverlayStorage, index: PersistentOverlayStorage, checkpointEnd: number) => void,
  convert: (source: PersistentOverlayStorage, target: PersistentOverlayStorage, index: PersistentOverlayStorage) => void,
  reportCleanupFailure: (error: unknown) => void,
): Promise<SelectedOverlayGeneration> {
  if (!Number.isSafeInteger(sourceGeneration + 1)) {
    throw new Error("persistent overlay generation number exhausted");
  }
  const sourceLength = source.len();
  const baseDigest = journalBaseDigest(files.sealCodec, source);
  let target: PersistentOverlayStorage | null = null;
  let index: PersistentOverlayStorage | null = null;
  let seal: PersistentOverlayStorage | null = null;
  let published = false;
  let failure: unknown;
  try {
    target = await files.open(targetSlot, "journal", true);
    index = await files.open(targetSlot, "index", true);
    seal = await files.open(targetSlot, "seal", true);
    if (target === null || index === null || seal === null) {
      throw new Error("could not open persistent overlay conversion files");
    }
    seal.truncate(0);
    seal.flush();
    target.truncate(0);
    target.flush();
    index.truncate(0);
    index.flush();
    convert(source, target, index);
    const generation = sourceGeneration + 1;
    const provenance: OverlaySealSource = {
      slot: sourceSlot, journalLength: sourceLength,
      ...(sourceSlot === "legacy" ? { journalDigest: digestOverlayStoragePrefix(files.sealCodec, source, sourceLength) } : {}),
    };
    writeOverlayGenerationSealSync(files.sealCodec, target, seal, generation, baseDigest, index,
      provenance);
    verifyOverlayGenerationSealSync(files.sealCodec, target, seal, baseDigest, false, index);
    const sealedLength = target.len();
    try {
      enable(target, index, sealedLength);
    } catch (error) {
      if (error instanceof RejectedOverlayGenerationError && error.errno === ERRNO.EIO) {
        throw new RejectedConvertedTargetError(error);
      }
      throw error;
    }
    published = true;
    return {
      journal: target, index, slot: targetSlot, generation, sealedLength,
      convertedFrom: { slot: sourceSlot, generation: sourceGeneration },
      source: provenance,
      activation: generationActivationIdentity(files.sealCodec, { journal: target, slot: targetSlot, generation }, seal, baseDigest),
    };
  } catch (error) {
    failure = error;
    if (seal !== null && !published) {
      let invalidated = false;
      try {
        seal.truncate(0);
        seal.flush();
        invalidated = true;
      } catch (cleanupError) {
        failure = new AggregateError([error, cleanupError], "persistent overlay conversion seal cleanup failed");
      }
      if (invalidated) {
        for (const storage of [index, target]) {
          if (storage === null) continue;
          try {
            storage.truncate(0);
            storage.flush();
          } catch (cleanupError) {
            try {
              reportCleanupFailure(cleanupError);
            } catch (reportError) {
              console.error("persistent overlay conversion cleanup report failed", cleanupError, reportError);
            }
          }
        }
      }
    }
    throw failure;
  } finally {
    const cleanupFailures: unknown[] = [];
    const close = (storage: PersistentOverlayStorage | null) => {
      try {
        storage?.close();
      } catch (error) {
        cleanupFailures.push(error);
      }
    };
    close(seal);
    if (!published) {
      close(index);
      close(target);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        failure === undefined ? cleanupFailures : [failure, ...cleanupFailures],
        "persistent overlay legacy conversion cleanup failed",
      );
    }
  }
}

export async function enableBestOverlayGeneration(
  files: OverlayGenerationFiles,
  enable: (journal: PersistentOverlayStorage, index?: PersistentOverlayStorage, checkpointEnd?: number) => void,
  requireExisting = false,
  convertJournal?: (source: PersistentOverlayStorage, target: PersistentOverlayStorage, index: PersistentOverlayStorage) => void,
  reportCleanupFailure: (error: unknown) => void = console.error,
): Promise<SelectedOverlayGeneration> {
  return withOverlayGenerationMetadata(files, async scope => {
    const controls = await openActivationControls(files);
    try {
      const selected = await enableBestOverlayGenerationInner(
        files, scope, enable, requireExisting, convertJournal, reportCleanupFailure, controls,
      );
      try {
        await controls.prepare();
        controls.publish(controls.next(await selectedActivationIdentity(selected, files)));
      } catch (error) { throw new UnconfirmedOverlayActivationError(error); }
      return selected;
    } finally { closeActivationControls(controls, files, reportCleanupFailure); }
  });
}

async function enableBestOverlayGenerationInner(
  files: OverlayGenerationFiles,
  scope: OverlayGenerationMetadataScope,
  enable: (journal: PersistentOverlayStorage, index?: PersistentOverlayStorage, checkpointEnd?: number) => void,
  requireExisting: boolean,
  convertJournal: ((source: PersistentOverlayStorage, target: PersistentOverlayStorage, index: PersistentOverlayStorage) => void) | undefined,
  reportCleanupFailure: (error: unknown) => void,
  controls: OverlayActivationControlPair,
): Promise<SelectedOverlayGeneration> {
  const activation = controls.current;
  const anchor = async (identity: Omit<OverlayActivationRecord, "sequence">): Promise<void> => {
    await controls.prepare();
    if (controls.current !== null) {
      nativeGenerationPolicy(() => files.activationCodec.requireInventory(controls.current, identity, false));
      return;
    }
    controls.publish(controls.next(identity));
  };
  const candidates: Candidate[] = [];
  const reusableSlots = new Map<number, SealedGenerationSlot>();
  const knownGenerations = new Map<SealedGenerationSlot, number>();
  const unverifiedSources = new Map<SealedGenerationSlot, { journalLength: number; sealLength: number }>();
  const select = (selected: SelectedOverlayGeneration): SelectedOverlayGeneration =>
    withKnownGenerations(withReusableSlots(selected, reusableSlots, files.activationCodec), knownGenerations);
  let foundGenerationFile = false;
  try {
    const { discovered, slots } = await generationSlots(files, scope);
    for (const name of discovered) knownGenerations.set(name as SealedGenerationSlot, 0);
    for (const slot of slots) {
      const journal = await files.open(slot, "journal", false);
      let seal: PersistentOverlayStorage | null = null;
      let index: PersistentOverlayStorage | null = null;
      try {
        seal = await files.open(slot, "seal", false);
        index = await files.open(slot, "index", false);
      } catch (error) {
        journal?.close();
        seal?.close();
        throw error;
      }
      foundGenerationFile ||= journal !== null || seal !== null || index !== null;
      if (journal === null || seal === null) {
        if ((journal?.len() ?? 0) > 0 || (seal?.len() ?? 0) > 0 || (index?.len() ?? 0) > 0) {
          unverifiedSources.set(slot, { journalLength: journal?.len() ?? 0, sealLength: seal?.len() ?? 0 });
        }
        journal?.close();
        seal?.close();
        index?.close();
        continue;
      }
      let journalLength = 0;
      let sealLength = 0;
      try {
        journalLength = journal.len();
        sealLength = seal.len();
        const verified = await verifyOverlayGenerationSeal(files.sealCodec, journal, seal, undefined, true, index);
        const retainedIndex = verified.indexLength === undefined ? undefined : index ?? undefined;
        candidates.push({ journal, index: retainedIndex, generation: verified.generation, sealedLength: verified.journalLength, slot, source: verified.source,
          activation: generationActivationIdentity(files.sealCodec, { journal, slot, generation: verified.generation }, seal, verified.baseDigest) });
        if (retainedIndex !== undefined) index = null;
        knownGenerations.set(slot, verified.generation);
      } catch (error) {
        if (error instanceof Error && error.message === "persistent overlay generation seal is invalid") {
          unverifiedSources.set(slot, { journalLength, sealLength });
        }
        journal.close();
        if (!(error instanceof Error) || error.message !== "persistent overlay generation seal is invalid") {
          throw error;
        }
      } finally {
        seal.close();
        index?.close();
      }
    }
    let anchored: Candidate | undefined;
    for (const candidate of [...candidates]) {
      const role = nativeGenerationPolicy(() => files.activationCodec.candidateRole(activation, candidate.activation));
      if (role === "active") anchored = candidate;
      if (role === "unanchored" || role === "active") continue;
      if (role === "unpublished") reusableSlots.set(candidate.generation, candidate.slot);
      candidates.splice(candidates.indexOf(candidate), 1);
      closeCandidate(candidate);
    }
    nativeGenerationPolicy(() => files.activationCodec.requireInventory(activation, anchored?.activation ?? null,
      [...unverifiedSources.values()].some(source => source.journalLength > 0 || source.sealLength > 0)));
    candidates.sort((left, right) => files.activationCodec.compareGenerations(left, right));
    for (let index = 1; index < candidates.length; index++) {
      files.activationCodec.compareGenerations(candidates[index - 1]!, candidates[index]!);
    }
    const verifiedCandidates = [...candidates];
    const staleCandidates: Candidate[] = [];
    const unresolvedCandidates = new Set<Candidate>();
    const supersededCandidates = new Set<Candidate>();
    for (const candidate of activation === null ? verifiedCandidates : []) {
      if (candidate.source === undefined) continue;
      let evidence: OverlayRecoveryEvidence;
      let unsealed: PersistentOverlayStorage | null = null;
      try {
        if (nativeGenerationPolicy(() => files.activationCodec.relationship(candidate, candidate.source!.slot, candidate)) === "self") evidence = { source: "self" };
        else if (candidate.source.slot === "legacy") {
          unsealed = await files.open("legacy", "journal", false);
          evidence = { source: "unsealed", expectedLength: candidate.source.journalLength,
            observedLength: unsealed?.len() ?? 0, hasDigest: candidate.source.journalDigest !== undefined };
        } else {
          let predecessor: Candidate | undefined;
          let slotReused = false;
          for (const other of verifiedCandidates) {
            const relationship = nativeGenerationPolicy(() => files.activationCodec.relationship(candidate, candidate.source!.slot, other));
            if (relationship !== "unrelated") slotReused = true;
            if (relationship === "predecessor") predecessor = other;
          }
          const unverified = unverifiedSources.get(candidate.source.slot);
          evidence = { source: "sealed", expectedLength: candidate.source.journalLength,
            observedLength: predecessor?.journal.len() ?? unverified?.journalLength ?? 0,
            unverifiedSealLength: unverified?.sealLength ?? 0, verifiedPredecessor: predecessor !== undefined,
            supersededPredecessor: predecessor !== undefined && supersededCandidates.has(predecessor),
            slotReused };
        }
        let verdict = files.sealCodec.classifySource(evidence);
        if (verdict === "verify-digest") {
          if (unsealed === null || candidate.source.journalDigest === undefined) throw new Error("Native recovery requested an unavailable source digest");
          const actual = digestOverlayStoragePrefix(files.sealCodec, unsealed, unsealed.len());
          verdict = files.sealCodec.classifySource({ ...evidence,
            digestMatches: candidate.source.journalDigest.every((byte, index) => byte === actual[index]) });
        }
        if (verdict === "verify-digest") throw new Error("Native recovery did not consume source digest evidence");
        if (verdict === "unresolved") unresolvedCandidates.add(candidate);
        if (verdict === "stale" || verdict === "superseded") staleCandidates.push(candidate);
        if (verdict === "superseded") supersededCandidates.add(candidate);
      } finally {
        unsealed?.close();
      }
    }
    for (const candidate of staleCandidates) {
      candidates.splice(candidates.indexOf(candidate), 1);
      reusableSlots.set(candidate.generation, candidate.slot);
      candidate.journal.close();
      candidate.index?.close();
    }
    candidates.sort((left, right) => files.activationCodec.compareGenerations(left, right, true));
    for (const candidate of [...candidates]) {
      if (unresolvedCandidates.has(candidate)) throw new NoValidOverlayGenerationError();
      try {
        const convertIndex = candidate.index !== undefined && convertJournal !== undefined
          && files.sealCodec.shouldConvertJournal(candidate.journal.len())
          && indexRequiresConversion(files.sealCodec, candidate.index);
        await anchor(candidate.activation);
        if (convertIndex && convertJournal !== undefined) {
          const targetSlot = conversionTarget(files, { ...candidate, knownGenerations }, slots, knownGenerations, reusableSlots.get(candidate.generation + 1));
          scope.retainSlot(targetSlot);
          assertGenerationTarget(files, { ...candidate, knownGenerations }, targetSlot);
          knownGenerations.set(targetSlot, 0);
          try {
            const converted = await convertOverlayGeneration(
              files, candidate.journal, candidate.slot, targetSlot, candidate.generation, enable, convertJournal,
              reportCleanupFailure,
            );
            candidates.splice(candidates.indexOf(candidate), 1);
            closeCandidate(candidate);
            return select(converted);
          } catch (error) {
            if (!(error instanceof RejectedConvertedTargetError) && !isStorageQuotaError(error)) throw error;
            enable(candidate.journal, candidate.index, candidate.sealedLength);
            candidates.splice(candidates.indexOf(candidate), 1);
            return select(candidate);
          }
        }
        try {
          enable(candidate.journal, candidate.index, candidate.sealedLength);
        } catch (error) {
          if (!(error instanceof RejectedOverlayGenerationError) || error.errno !== ERRNO.ENOMEM || !error.pristineRecovery
            || convertJournal === undefined) throw error;
          const targetSlot = conversionTarget(files, { ...candidate, knownGenerations }, slots, knownGenerations, reusableSlots.get(candidate.generation + 1));
          scope.retainSlot(targetSlot);
          assertGenerationTarget(files, { ...candidate, knownGenerations }, targetSlot);
          knownGenerations.set(targetSlot, 0);
          const converted = await convertOverlayGeneration(
            files, candidate.journal, candidate.slot, targetSlot, candidate.generation, enable, convertJournal,
            reportCleanupFailure,
          );
          candidates.splice(candidates.indexOf(candidate), 1);
          closeCandidate(candidate);
          return select(converted);
        }
        candidates.splice(candidates.indexOf(candidate), 1);
        return select(candidate);
      } catch (error) {
        if (!(error instanceof RejectedOverlayGenerationError) || error.errno !== ERRNO.EIO) {
          throw error;
        }
        throw new NoValidOverlayGenerationError();
      }
    }
    const legacy = await files.open("legacy", "journal", !foundGenerationFile && !requireExisting);
    if (legacy === null) {
      throw new NoValidOverlayGenerationError();
    }
    try {
      const legacyLength = legacy.len();
      if ((foundGenerationFile || requireExisting || activation !== null) && legacyLength === 0) {
        throw new NoValidOverlayGenerationError();
      }
      if (legacyLength > 0) await anchor(generationActivationIdentity(files.sealCodec, { journal: legacy, slot: "legacy", generation: 0 }));
      if (convertJournal !== undefined && files.sealCodec.shouldConvertJournal(legacyLength)) {
        let converted: SelectedOverlayGeneration;
        const targetSlot = conversionTarget(files, { slot: "legacy", generation: 0, knownGenerations }, slots, knownGenerations, reusableSlots.get(1) ?? "g0");
        scope.retainSlot(targetSlot);
        assertGenerationTarget(files, { slot: "legacy", generation: 0, knownGenerations }, targetSlot);
        knownGenerations.set(targetSlot, 0);
        try {
          converted = await convertOverlayGeneration(
            files, legacy, "legacy", targetSlot, 0, enable, convertJournal, reportCleanupFailure,
          );
        } catch (error) {
          if (error instanceof RejectedConvertedTargetError || isStorageQuotaError(error)) {
            try {
              enable(legacy);
            } catch (sourceError) {
              if (sourceError instanceof RejectedOverlayGenerationError && sourceError.errno === ERRNO.EIO) {
                throw new NoValidOverlayGenerationError();
              }
              throw sourceError;
            }
            return select({ journal: legacy, slot: "legacy", generation: 0, sealedLength: 0 });
          }
          if (error instanceof RejectedOverlayGenerationError && error.errno === ERRNO.EIO) {
            throw new NoValidOverlayGenerationError();
          }
          throw error;
        }
        legacy.close();
        return select(converted);
      }
      try {
        enable(legacy);
      } catch (error) {
        if (legacyLength > 0 && error instanceof RejectedOverlayGenerationError && error.errno === ERRNO.ENOMEM && error.pristineRecovery
          && convertJournal !== undefined) {
          const targetSlot = conversionTarget(files, { slot: "legacy", generation: 0, knownGenerations }, slots, knownGenerations, reusableSlots.get(1) ?? "g0");
          scope.retainSlot(targetSlot);
          assertGenerationTarget(files, { slot: "legacy", generation: 0, knownGenerations }, targetSlot);
          knownGenerations.set(targetSlot, 0);
          let converted: SelectedOverlayGeneration;
          try {
            converted = await convertOverlayGeneration(
              files, legacy, "legacy", targetSlot, 0, enable, convertJournal, reportCleanupFailure,
            );
          } catch (conversionError) {
            if (conversionError instanceof RejectedOverlayGenerationError && conversionError.errno === ERRNO.EIO) {
              throw new NoValidOverlayGenerationError();
            }
            throw conversionError;
          }
          legacy.close();
          return select(converted);
        }
        if (legacyLength > 0 && error instanceof RejectedOverlayGenerationError && error.errno === ERRNO.EIO) {
          throw new NoValidOverlayGenerationError();
        }
        throw error;
      }
      return select({ journal: legacy, slot: "legacy", generation: 0, sealedLength: 0 });
    } catch (error) {
      legacy.close();
      throw error;
    }
  } finally {
    for (const candidate of candidates) {
      candidate.journal.close();
      candidate.index?.close();
    }
  }
}

export async function compactOverlayGeneration(
  selected: SelectedOverlayGeneration,
  files: OverlayGenerationFiles,
  handoff: OverlayCompactionHandoff,
  minTailBytes = 32 * 1024 * 1024,
  shouldProceed: () => boolean = () => true,
  reportCleanupFailure: (error: unknown) => void = console.error,
): Promise<SelectedOverlayGeneration> {
  return withOverlayGenerationMetadata(files, scope => {
    for (const slot of selected.knownGenerations?.keys() ?? []) scope.retainSlot(slot);
    for (const slot of selected.reusableSlots?.values() ?? []) scope.retainSlot(slot);
    if (selected.slot !== "legacy") scope.retainSlot(selected.slot);
    return compactOverlayGenerationInner(selected, files, scope, handoff, minTailBytes, shouldProceed, reportCleanupFailure);
  });
}

async function compactOverlayGenerationInner(
  selected: SelectedOverlayGeneration,
  files: OverlayGenerationFiles,
  scope: OverlayGenerationMetadataScope,
  handoff: OverlayCompactionHandoff,
  minTailBytes: number,
  shouldProceed: () => boolean,
  reportCleanupFailure: (error: unknown) => void,
): Promise<SelectedOverlayGeneration> {
  if (selected.journal.len() - selected.sealedLength < minTailBytes && handoff.memoryPressure?.() !== true) return selected;
  if (typeof handoff.fail !== "function") throw new Error("Compaction requires a synchronous writer-failure handler");
  if (!Number.isSafeInteger(selected.generation + 1)) {
    throw new Error("persistent overlay generation number exhausted");
  }
  const ringIndex = COMPACTION_SLOTS.findIndex((candidate) => candidate === selected.slot);
  const reusable = selected.reusableSlots?.get(selected.generation + 1);
  let slot = reusable !== undefined && mayUseGenerationTarget(files, selected, reusable) ? reusable : undefined;
  for (let offset = 1; slot === undefined && offset <= COMPACTION_SLOTS.length; offset++) {
    const candidate = COMPACTION_SLOTS[(ringIndex + offset) % COMPACTION_SLOTS.length]!;
    if (mayUseGenerationTarget(files, selected, candidate)) slot = candidate;
  }
  if (slot === undefined) throw new NoValidOverlayGenerationError();
  scope.retainSlot(slot);
  const controls = await openActivationControls(files);
  try {
    await controls.prepare();
    const identity = await selectedActivationIdentity(selected, files);
    if (controls.current === null) controls.publish(controls.next(identity));
    else nativeGenerationPolicy(() => files.activationCodec.requireInventory(controls.current, identity, false));
    return await compactControlledOverlayGeneration(
      selected, files, slot, handoff, shouldProceed, reportCleanupFailure, controls,
    );
  } finally { closeActivationControls(controls, files, reportCleanupFailure); }
}

async function compactControlledOverlayGeneration(
  selected: SelectedOverlayGeneration,
  files: OverlayGenerationFiles,
  slot: SealedGenerationSlot,
  handoff: OverlayCompactionHandoff,
  shouldProceed: () => boolean,
  reportCleanupFailure: (error: unknown) => void,
  controls: OverlayActivationControlPair,
): Promise<SelectedOverlayGeneration> {
  assertGenerationTarget(files, selected, slot);
  const target = await files.open(slot, "journal", true);
  if (target === null) throw new Error("could not create persistent overlay target journal");
  let seal: PersistentOverlayStorage | null = null;
  let index: PersistentOverlayStorage | null = null;
  let prepared = false;
  let activated = false;
  let activationAttempted = false;
  let activationPublished = false;
  let targetTouched = false;
  let sealedLength = 0;
  let sourceProvenance: OverlaySealSource | undefined;
  const closeActivatedStorage = (storage: PersistentOverlayStorage | null | undefined): void => {
    if (storage === null || storage === undefined) return;
    try {
      storage.close();
    } catch (error) {
      try {
        reportCleanupFailure(error);
      } catch (reportError) {
        console.error("persistent overlay compaction cleanup report failed", error, reportError);
      }
    }
  };
  try {
    seal = await files.open(slot, "seal", true);
    if (seal === null) throw new Error("could not create persistent overlay target seal");
    index = await files.open(slot, "index", true);
    if (index === null) throw new Error("could not create persistent overlay target checkpoint");
    if (!shouldProceed()) {
      seal.close();
      index.close();
      target.close();
      return selected;
    }
    seal.truncate(0);
    seal.flush();
    targetTouched = true;
    target.truncate(0);
    target.flush();
    index.truncate(0);
    index.flush();
    handoff.prepare(target);
    prepared = true;
    const sourceLength = selected.journal.len();
    handoff.checkpoint(index);
    const baseDigest = controls.current!.baseDigest;
    const generation = selected.generation + 1;
    sourceProvenance = {
      slot: selected.slot, journalLength: sourceLength,
      ...(selected.slot === "legacy"
        ? { journalDigest: digestOverlayStoragePrefix(files.sealCodec, selected.journal, sourceLength) } : {}),
    };
    writeOverlayGenerationSealSync(files.sealCodec, target, seal, generation, baseDigest, index,
      sourceProvenance);
    verifyOverlayGenerationSealSync(files.sealCodec, target, seal, baseDigest, false, index);
    sealedLength = target.len();
    const nextActivation = controls.next(generationActivationIdentity(files.sealCodec, { journal: target, slot, generation }, seal, baseDigest));
    activationAttempted = true;
    handoff.activate();
    activated = true;
    prepared = false;
    controls.publish(nextActivation);
    activationPublished = true;
    closeActivatedStorage(seal);
    seal = null;
    closeActivatedStorage(selected.journal);
    closeActivatedStorage(selected.index);
    const active = withKnownGenerations(
      withReusableSlots({ journal: target, index, slot, generation, sealedLength, source: sourceProvenance, activation: nextActivation }, selected.reusableSlots ?? new Map(), files.activationCodec),
      selected.knownGenerations ?? new Map(),
    );
    const collected = await collectObsoleteGenerations(active, selected, files, reportCleanupFailure, controls.current, nextActivation);
    await retireLegacySource(collected, selected, files, reportCleanupFailure);
    return collected;
  } catch (error) {
    if (activationAttempted && !activationPublished) {
      const failure = new UnconfirmedOverlayActivationError(error);
      try { handoff.fail(failure); }
      catch (poisonFailure) {
        throw new UnconfirmedOverlayActivationError(new AggregateError([error, poisonFailure], "Activation publication and writer shutdown failed"));
      }
      throw failure;
    }
    if (activated && index !== null) {
      reportCleanupFailure(error);
      return withKnownGenerations(
        withReusableSlots(
          { journal: target, index, slot, generation: selected.generation + 1, sealedLength, source: sourceProvenance, activation: controls.current! },
          selected.reusableSlots ?? new Map(),
          files.activationCodec,
        ),
        selected.knownGenerations ?? new Map(),
      );
    }
    let failure: unknown = error;
    const openedSeal = seal;
    const openedIndex = index;
    let sealInvalidated = false;
    let preparationCanceled = !prepared;
    const cleanup = (operation: () => void): void => {
      try {
        operation();
      } catch (cleanupError) {
        failure = new AggregateError([failure, cleanupError], "persistent overlay compaction cleanup failed");
      }
    };
    if (targetTouched && openedSeal !== null) {
      cleanup(() => {
        openedSeal.truncate(0);
        openedSeal.flush();
        sealInvalidated = true;
      });
    }
    if (prepared) cleanup(() => {
      handoff.cancel();
      preparationCanceled = true;
    });
    if (sealInvalidated && preparationCanceled) {
      for (const storage of [openedIndex, target]) {
        if (storage === null) continue;
        try {
          storage.truncate(0);
          storage.flush();
        } catch (cleanupError) {
          try {
            reportCleanupFailure(cleanupError);
          } catch (reportError) {
            console.error("persistent overlay compaction cleanup report failed", cleanupError, reportError);
          }
        }
      }
    }
    if (openedSeal !== null) cleanup(() => openedSeal.close());
    if (openedIndex !== null) cleanup(() => openedIndex.close());
    cleanup(() => target.close());
    throw failure;
  }
}

export async function compactOverlayGenerationForBoot(
  selected: SelectedOverlayGeneration,
  files: OverlayGenerationFiles,
  handoff: OverlayCompactionHandoff,
  reportDeferred: (error: unknown) => void,
): Promise<SelectedOverlayGeneration> {
  let activationAttempted = false;
  try {
    return await compactOverlayGeneration(selected, files, {
      ...handoff,
      activate: () => {
        activationAttempted = true;
        handoff.activate();
      },
    });
  } catch (error) {
    if (activationAttempted || !isStorageQuotaError(error)) throw error;
    reportDeferred(error);
    return selected;
  }
}

export class LiveOverlayCompactor {
  #selected: SelectedOverlayGeneration;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running: Promise<void> | null = null;
  #stopped = false;
  #retryAfter = 0;

  constructor(
    selected: SelectedOverlayGeneration,
    private readonly files: OverlayGenerationFiles,
    private readonly handoff: OverlayCompactionHandoff,
    private readonly onGeneration: (next: SelectedOverlayGeneration) => void,
    private readonly onError: (error: unknown) => void,
    private readonly minTailBytes = 32 * 1024 * 1024,
  ) {
    this.#selected = selected;
  }

  start(): void {
    if (this.#timer !== null || this.#stopped) return;
    this.#timer = setInterval(() => { void this.compactIfNeeded(); }, 2_000);
  }

  stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    return this.#running ?? Promise.resolve();
  }

  compactIfNeeded(): Promise<void> {
    if (this.#stopped || Date.now() < this.#retryAfter) return Promise.resolve();
    if (this.#running !== null) return this.#running;
    this.#running = this.#compact();
    return this.#running;
  }

  async #compact(): Promise<void> {
    const selected = this.#selected;
    try {
      const next = await compactOverlayGeneration(
        selected,
        this.files,
        this.handoff,
        this.minTailBytes,
        () => !this.#stopped && this.#selected === selected,
        this.onError,
      );
      if (next !== selected) {
        this.#selected = next;
        this.onGeneration(next);
      }
    } catch (error) {
      if (error instanceof UnconfirmedOverlayActivationError) {
        this.#stopped = true;
        if (this.#timer !== null) clearInterval(this.#timer);
        this.#timer = null;
      } else this.#retryAfter = Date.now() + 30_000;
      this.onError(error);
    } finally {
      this.#running = null;
    }
  }
}
