import { digestOverlayStoragePrefix, writeOverlayGenerationSeal } from "../../../../host/src/vfs/overlay-generation-seal";
import { OverlayActivationControlPair } from "../../../../host/src/vfs/overlay-generation-activation";
import { enableBestOverlayGeneration, isNoValidOverlayGenerationError, type OverlayGenerationFiles, type OverlayGenerationSlot } from "../../../../host/src/vfs/overlay-generation-selection";
import { OpfsOverlayStorageFile } from "../../../../host/src/vfs/overlay-storage";
import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs";
import { createOverlayActivationCodec } from "../../../../host/src/vfs/overlay-activation-codec";
import { createOverlaySealCodec } from "../../../../host/src/vfs/overlay-seal-codec";
import type { PersistentOverlayStorage } from "../../../../host/src/vfs/overlay-storage";

type Scenario = "seal" | "index" | "missing-index" | "retirement" | "newer-descendant"
  | "unanchored-retirement" | "unanchored-newer-descendant" | "fingerprint-close";

async function fingerprintCleanup(files: OverlayGenerationFiles) {
  let indexCloses = 0;
  let fingerprintReads = 0;
  let enabled = 0;
  let refused = false;
  let retainedIndex: PersistentOverlayStorage | undefined;
  const failure = new Error("injected fingerprint read failure");
  try {
    const journal = await files.open("g0", "journal", true);
    const index = await files.open("g0", "index", true);
    const seal = await files.open("g0", "seal", true);
    if (journal === null || index === null || seal === null) throw new Error("cleanup fixture creation failed");
    try {
      journal.writeAllAt(0, Uint8Array.of(1, 2, 3));
      index.writeAllAt(0, Uint8Array.of(4));
      await writeOverlayGenerationSeal(files.sealCodec, journal, seal, 1, new Uint8Array(32), index);
    } finally { journal.close(); index.close(); seal.close(); }
    const observed: OverlayGenerationFiles = { ...files, open: async (slot, kind, create) => {
      const storage = await files.open(slot, kind, create);
      if (storage === null || slot !== "g0" || create) return storage;
      if (kind === "index") retainedIndex = storage;
      return {
        len: () => storage.len(),
        readExactAt: (offset, destination) => {
          if (kind === "seal" && Number(offset) === 0 && destination.length === storage.len()) {
            fingerprintReads++;
            throw failure;
          }
          storage.readExactAt(offset, destination);
        },
        writeAllAt: (offset, bytes) => storage.writeAllAt(offset, bytes),
        flush: () => storage.flush(), truncate: length => storage.truncate(length),
        close: () => { storage.close(); if (kind === "index") indexCloses++; },
      };
    } };
    try { await enableBestOverlayGeneration(observed, () => { enabled++; }, true); }
    catch (error) { if (error !== failure) throw error; refused = true; }
    return { refused, enabled, indexCloses, fingerprintReads };
  } finally {
    if (indexCloses === 0) retainedIndex?.close();
    for (const kind of ["journal", "index", "seal"] as const) await files.remove("g0", kind);
    for (const kind of ["activation0", "activation1"] as const) await files.remove("legacy", kind);
  }
}

self.onmessage = async (event: MessageEvent<{ name: string; scenario: Scenario; imageModuleUrl: string }>) => {
  const { name, scenario, imageModuleUrl } = event.data;
  const moduleResponse = await fetch(imageModuleUrl);
  if (!moduleResponse.ok) throw new Error("Native activation fixture module is unavailable");
  const filesystem = KandeloImageFs.create(new Uint8Array(await moduleResponse.arrayBuffer()));
  const files: OverlayGenerationFiles = {
    activationCodec: createOverlayActivationCodec((operation, input) => filesystem.overlayActivationCodecCall(operation, input)),
    sealCodec: createOverlaySealCodec((operation, input) => filesystem.overlayActivationCodecCall(operation, input)),
    listSlots: () => OpfsOverlayStorageFile.listSlots(name),
    open: (slot, kind, create) => OpfsOverlayStorageFile.openFile(name, slot, kind, create),
    remove: (slot, kind) => OpfsOverlayStorageFile.removeFile(name, slot, kind),
  };
  if (scenario === "fingerprint-close") {
    self.postMessage(await fingerprintCleanup(files));
    return;
  }
  const failures: string[] = [];
  const stage = (value: string) => self.postMessage({ stage: value });
  let result: unknown;
  try {
    const digest = new Uint8Array(32);
    const generations = scenario.endsWith("newer-descendant") ? 3 : 2;
    for (let generation = 1; generation <= generations; generation++) {
      const slot: OverlayGenerationSlot = `g${generation - 1}`;
      stage(`create:${slot}`);
      const journal = await files.open(slot, "journal", true);
      const index = await files.open(slot, "index", true);
      const seal = await files.open(slot, "seal", true);
      if (journal === null || index === null || seal === null) throw new Error("fixture creation failed");
      try {
        journal.writeAllAt(0, Uint8Array.of(generation, 2, 3));
        index.writeAllAt(0, Uint8Array.of(4));
        await writeOverlayGenerationSeal(files.sealCodec, journal, seal, generation, digest, index,
          generation === 1 ? undefined : { slot: `g${generation - 2}`, journalLength: 3 });
      } finally { seal.close(); index.close(); journal.close(); }
    }
    if (scenario === "retirement" || scenario === "newer-descendant") {
      stage("publish-activation");
      const slot: OverlayGenerationSlot = `g${generations - 1}`;
      const seal = await files.open(slot, "seal", false);
      if (seal === null) throw new Error("active seal missing");
      let sealDigest: Uint8Array;
      try { sealDigest = digestOverlayStoragePrefix(files.sealCodec, seal, seal.len()); }
      finally { seal.close(); }
      const controls = await OverlayActivationControlPair.open({
        activationCodec: files.activationCodec,
        open: (replica, create) => files.open("legacy", replica === 0 ? "activation0" : "activation1", create),
      });
      try {
        await controls.prepare();
        controls.publish(controls.next({ slot, generation: generations, baseDigest: digest, sealDigest }));
      } finally { controls.close(); }
    }
    stage("append-source");
    const source = await files.open("g0", "journal", false);
    if (source === null) throw new Error("source missing");
    try { source.writeAllAt(3, Uint8Array.of(9)); source.flush(); }
    finally { source.close(); }
    stage("inject-fault");
    if (scenario === "missing-index") await files.remove("g0", "index");
    else {
      const storage = await files.open("g0", scenario === "index" ? "index" : "seal", false);
      if (storage === null) throw new Error("fault target missing");
      try {
        if (scenario.endsWith("retirement")) storage.truncate(0);
        else {
          const byte = new Uint8Array(1);
          storage.readExactAt(0, byte);
          byte[0] ^= 1;
          storage.writeAllAt(0, byte);
        }
        storage.flush();
      } finally { storage.close(); }
    }
    const snapshot = async () => {
      const contents: Record<string, number[]> = {};
      for await (const slot of await files.listSlots()) {
        for (const kind of ["journal", "seal", "index"] as const) {
          const storage = await files.open(slot as OverlayGenerationSlot, kind, false);
          if (storage === null) continue;
          try {
            const bytes = new Uint8Array(storage.len());
            storage.readExactAt(0, bytes);
            contents[`${slot}.${kind}`] = [...bytes];
          } finally { storage.close(); }
        }
      }
      for (const kind of ["activation0", "activation1"] as const) {
        const storage = await files.open("legacy", kind, false);
        if (storage === null) continue;
        try {
          const bytes = new Uint8Array(storage.len());
          storage.readExactAt(0, bytes);
          contents[kind] = [...bytes];
        } finally { storage.close(); }
      }
      return JSON.stringify(contents);
    };
    stage("snapshot-before");
    const before = await snapshot();
    let enabled = 0;
    let selected: string | null = null;
    let refused = false;
    stage("select");
    try {
      const mounted = await enableBestOverlayGeneration(files, () => { enabled++; }, true);
      try { selected = mounted.slot; }
      finally { mounted.index?.close(); mounted.journal.close(); }
    } catch (error) {
      if (!isNoValidOverlayGenerationError(error)) throw error;
      refused = true;
    }
    stage("snapshot-after");
    result = { selected, refused, enabled, unchanged: before === await snapshot() };
  } catch (error) { failures.push(String(error)); }
  finally {
    stage(`cleanup-list:${failures.join(" | ")}`);
    for await (const slot of await files.listSlots()) {
      for (const kind of ["journal", "seal", "index"] as const) {
        stage(`cleanup:${slot}.${kind}:${failures.join(" | ")}`);
        try { await files.remove(slot as OverlayGenerationSlot, kind); }
        catch (error) { failures.push(String(error)); }
      }
    }
    for (const kind of ["activation0", "activation1"] as const) {
      try { await files.remove("legacy", kind); }
      catch (error) { failures.push(String(error)); }
    }
  }
  self.postMessage(failures.length === 0 ? result : { error: failures.join(" | ") });
};
