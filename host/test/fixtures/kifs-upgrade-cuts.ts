import type { CentralizedKernelWorker } from "../../src/kernel-worker";
import { compactOverlayGeneration, type OverlayGenerationFiles } from "../../src/vfs/overlay-generation-selection";

export const upgradeCuts = ["target-reset", "copying", "trial-complete", "seal-flushed",
  "seal-verified", "first-control-flushed", "both-controls-flushed"] as const;
export type UpgradeCut = typeof upgradeCuts[number];
export type OwnerAction = "seed" | "seed-sealed" | "verify-deferred" | "retire-interrupted" | "recover-changed" | "quota" | "retry" | "recover" | "reopen" | UpgradeCut | `compact-${UpgradeCut}` | "interrupt-writeback" | "retry-writeback" | "verify-retried-writeback" | "verify-writeback" | "compact" | "recover-live" | "confirm-live" | "churn";

export interface OwnerResult {
  cut?: UpgradeCut;
  refusedAt?: "append" | "flush";
  volume?: boolean;
  generation?: number;
  reclaimed?: string[];
  value?: number;
  retiredFirstFile?: boolean;
  physicalBefore?: number;
  physicalAfter?: number;
}

/** Each call runs in a fresh kernel worker with exclusive storage ownership. */
export async function runUpgradeOwner(
  kernel: CentralizedKernelWorker, files: OverlayGenerationFiles, action: OwnerAction,
  reportCut: (message: OwnerResult) => void,
): Promise<OwnerResult> {
  const reclaimed: string[] = [];
  let publishing = false;
  let refuseSync = false;
  let refusedAt: "append" | "flush" | undefined;
  const quota = (phase: "append" | "flush") => {
    refusedAt = phase;
    throw Object.assign(new Error("injected active-volume quota"), { code: "ENOSPC" });
  };
  const loseOwner = (result: OwnerResult) => {
    reportCut(result);
    // The controller terminates this worker with its storage handles open.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw new Error("interrupted storage owner resumed");
  };
  const stop = (at: UpgradeCut) => {
    if (action !== at && action !== `compact-${at}`) return;
    loseOwner({ cut: at });
  };
  const observed: OverlayGenerationFiles = {
    ...files,
    async remove(slot, kind) {
      await files.remove(slot, kind);
      if (action === "retire-interrupted" && kind === "journal") loseOwner({ retiredFirstFile: true });
    },
    listSlots: () => {
      if (action === "reopen" || action === "confirm-live") throw new Error("active volume boot enumerated generation slots");
      return files.listSlots();
    },
    async open(slot, file, create) {
      if ((action === "reopen" || action === "confirm-live") && (file === "journal" || file === "index" || file === "seal")) {
        throw new Error("active volume boot opened a legacy generation file");
      }
      const storage = await files.open(slot, file, create);
      if (storage === null) return null;
      let wrote = false;
      return {
        len: () => storage.len(),
        close: () => storage.close(),
        truncate: length => {
          if (Number(length) === 0 && storage.len() > 0 && (file === "volume" || file === "volume-seal")) {
            reclaimed.push(file);
          }
          storage.truncate(length);
        },
        writeAllAt: (offset, bytes) => {
          if (file === "volume-seal") stop("trial-complete");
          if (action === "quota" && file === "volume" && wrote) {
            throw Object.assign(new Error("injected host quota"), { code: "ENOSPC" });
          }
          if (refuseSync && file === "volume") {
            if (Number(offset) < 8192) throw new Error("attempted a root write before flushing staged changes");
            // Real positioned storage can accept a prefix before refusing growth.
            storage.writeAllAt(offset, bytes.subarray(0, Math.min(bytes.length, 7)));
            quota("append");
          }
          storage.writeAllAt(offset, bytes);
          wrote = true;
          if (file === "volume") stop("copying");
        },
        readExactAt: (offset, bytes) => {
          storage.readExactAt(offset, bytes);
          if (file === "volume-seal" && wrote) {
            publishing = true;
            stop("seal-verified");
          }
        },
        flush: () => {
          if (refuseSync && file === "volume") quota("flush");
          storage.flush();
          if (file === "volume" && !wrote) stop("target-reset");
          if (file === "volume-seal" && wrote) stop("seal-flushed");
          if (publishing && wrote && file === "activation0") stop("first-control-flushed");
          if (publishing && wrote && file === "activation1") stop("both-controls-flushed");
        },
      };
    },
  };
  if (action === "recover-changed") {
    // The fixture simulates an externally restored journal after activation.
    const different = await files.open("legacy", "journal", false);
    if (!different) throw new Error("missing interrupted predecessor");
    try { different.writeAllAt(different.len(), Uint8Array.of(111)); different.flush(); }
    finally { different.close(); }
  }
  const upgrade = action === "retry" || action === "quota" || upgradeCuts.some(cut => cut === action);
  const seed = action === "seed" || action === "seed-sealed";
  const diagnostics: string[] = [];
  const boot = await kernel.bootComputerPersistence(observed, true, !seed,
    message => diagnostics.push(message), upgrade ? "development" : "legacy", () => {});
  let volume = "volume" in boot ? boot.volume : undefined;
  let legacy = "active" in boot ? boot.active : undefined;
  try {
    if (action === "interrupt-writeback" || action === "retry-writeback") {
      kernel.rootfsWriteFile("/sync-boundary", Uint8Array.of(41), 0o600);
      kernel.syncRootfsPersistence();
      kernel.rootfsWriteFile("/sync-boundary", Uint8Array.of(40), 0o600);
      kernel.rootfsWriteFile("/sync-boundary", Uint8Array.of(42), 0o600);
      if (kernel.rootfsReadFile("/sync-boundary")[0] !== 42) throw new Error("pending write was invisible");
      refuseSync = true;
      let failure: unknown;
      try { kernel.syncRootfsPersistence(); } catch (error) { failure = error; }
      if (!refusedAt || !String(failure).includes("errno 28")) {
        throw new Error("sync did not surface the injected quota failure: " + String(failure));
      }
      if (kernel.rootfsReadFile("/sync-boundary")[0] !== 42) throw new Error("failed sync lost live data");
      if (action === "interrupt-writeback") loseOwner({ value: 42, refusedAt });
      refuseSync = false;
      kernel.syncRootfsPersistence();
      loseOwner({ value: 42, refusedAt });
    }
    if (action === "verify-retried-writeback") {
      if (kernel.rootfsReadFile("/sync-boundary")[0] !== 42) throw new Error("lost a successfully retried sync");
      return { value: 42 };
    }
    if (action === "verify-writeback") {
      if (kernel.rootfsReadFile("/sync-boundary")[0] !== 41) throw new Error("wrong root after interrupted writeback");
      return { value: 41 };
    }
    if (action === "churn") {
      if (!("volume" in boot)) throw new Error("churn requires a saved volume");
      const data = new Uint8Array(65536).fill(117);
      for (let i = 0; i < 512 && !kernel.kifsCompactionNeeded(); i++) {
        kernel.rootfsWriteFile("/churn", data, 0o600);
      }
      if (!kernel.kifsCompactionNeeded()) throw new Error("physical growth did not request compaction");
      const physicalBefore = boot.volume.len();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let switched!: () => void;
      let failed!: (error: unknown) => void;
      const done = new Promise<void>((resolve, reject) => {
        switched = resolve;
        failed = reject;
        timer = setTimeout(() => reject(new Error("periodic KIFS compaction timed out")), 30_000);
      });
      const compactor = kernel.createLiveKifsCompactor(boot, observed, target => { volume = target; switched(); }, failed);
      compactor.start();
      try { await done; } finally { clearTimeout(timer); await compactor.stop(); }
      if (kernel.kifsCompactionNeeded()) throw new Error("compacted volume immediately requested another copy");
      const saved = kernel.rootfsReadFile("/churn");
      if (saved.length !== data.length || !saved.every(byte => byte === 117)) throw new Error("compaction lost data");
      return { physicalBefore, physicalAfter: volume!.len() };
    }
    if (action === "compact" || action.startsWith("compact-")) {
      if (!("volume" in boot)) throw new Error("live compaction requires an active volume");
      const failures: unknown[] = [];
      const compactor = kernel.createLiveKifsCompactor(boot, observed, target => { volume = target; },
        error => { failures.push(error); });
      try { await compactor.compactNow(); } finally { await compactor.stop(); }
      if (failures.length) throw failures[0];
    }
    if (action === "seed-sealed") {
      if (!("active" in boot)) throw new Error("checkpoint requires a legacy source");
      kernel.rootfsWriteFile("/saved-before-cut", Uint8Array.of(7), 0o640);
      kernel.syncRootfsPersistence();
      legacy = await compactOverlayGeneration(boot.active, observed, boot.handoff, 0);
      if (legacy.slot === "legacy") throw new Error("legacy checkpoint was not activated");
    }
    if (seed) kernel.rootfsWriteFile("/saved-before-cut", Uint8Array.of(17), 0o640);
    const saved = kernel.rootfsReadFile("/saved-before-cut");
    if (saved.length !== 1 || saved[0] !== 17) throw new Error("lost the acknowledged legacy file");
    if (action === "recover-changed") {
      if (!diagnostics.some(message => message.includes("Preserved the predecessor files"))) throw new Error("unproven source was not reported");
      const preserved = await files.open("legacy", "journal", false);
      if (!preserved) throw new Error("upgrade cleanup removed the changed journal");
      try {
        const last = new Uint8Array(1);
        preserved.readExactAt(preserved.len() - 1, last);
        if (last[0] !== 111) throw new Error("upgrade cleanup altered the changed journal");
      } finally { preserved.close(); }
    }
    if (action === "recover" || action === "recover-changed") kernel.rootfsWriteFile("/saved-after-cut", Uint8Array.of(83), 0o600);
    if (action === "quota") {
      if (!legacy || !diagnostics.some(message => message.includes("host storage quota"))) throw new Error("upgrade quota was not reported");
      const target = await files.open("g0", "volume", false);
      try { if (target?.len() !== 0) throw new Error("failed upgrade retained partial data"); }
      finally { target?.close(); }
      kernel.rootfsWriteFile("/after-deferred-upgrade", Uint8Array.of(39), 0o600);
    }
    if (action === "verify-deferred" && kernel.rootfsReadFile("/after-deferred-upgrade")[0] !== 39) {
      throw new Error("upgrade retry lost a write acknowledged after the quota refusal");
    }
    const value = seed || action === "quota" ? saved[0] : kernel.rootfsReadFile("/saved-after-cut")[0];
    if (action === "recover-live") kernel.rootfsWriteFile("/live-after-cut", Uint8Array.of(91), 0o600);
    if (action === "recover" && "volume" in boot && boot.authority.slot === "g1") {
      // The interrupted sealed-source cleanup already removed the journal.
      // Recovery must finish the remaining independently authenticated files.
      for (const [slot, kind] of [["g0", "journal"], ["g0", "index"], ["g0", "seal"], ["g1", "retirement"]] as const) {
        const residue = await files.open(slot, kind, false);
        if (residue) { residue.close(); throw new Error("incomplete source retirement: " + kind); }
      }
    }
    if (action === "confirm-live" && kernel.rootfsReadFile("/live-after-cut")[0] !== 91) {
      throw new Error("live handoff lost a write acknowledged after recovery");
    }
    kernel.syncRootfsPersistence();
    return { volume: "volume" in boot, generation: "volume" in boot ? boot.authority.generation : legacy!.generation, reclaimed: reclaimed.sort(), value };
  } finally {
    if ("volume" in boot) volume!.close();
    else if (legacy) { try { legacy.index?.close(); } finally { legacy.journal.close(); } }
  }
}

export async function exerciseOwnerLoss(
  cut: UpgradeCut, boot: (action: OwnerAction) => Promise<OwnerResult>,
  expectIndexAppendQuota = false,
): Promise<void> {
  // Cover both the bare first journal and a sealed checkpoint with a newer tail
  // on either side of the first durable KIFS activation replica.
  const seed = await boot(cut === "seal-verified" || cut === "first-control-flushed" ? "seed-sealed" : "seed");
  if (seed.volume !== false || seed.value !== 17) throw new Error("legacy seed failed");
  if (cut === "target-reset" && (await boot("quota")).volume !== false) throw new Error("quota changed the active filesystem");
  if ((await boot(cut)).cut !== cut) throw new Error("worker did not reach " + cut);
  if (cut === "first-control-flushed" && !(await boot("retire-interrupted")).retiredFirstFile) {
    throw new Error("did not interrupt retirement of the sealed predecessor");
  }
  const recovered = await boot(cut === "both-controls-flushed" ? "recover-changed" : "recover");
  const published = cut === "first-control-flushed" || cut === "both-controls-flushed";
  if (recovered.volume !== published || recovered.value !== 83) throw new Error("incorrect authority after " + cut);
  const retry = await boot("retry");
  const expected = published || cut === "target-reset" ? [] : ["volume"];
  if (cut === "seal-flushed" || cut === "seal-verified") expected.push("volume-seal");
  if (retry.volume !== true || retry.value !== 83 || retry.reclaimed?.join() !== expected.join()) {
    throw new Error("retry after " + cut + " returned " + JSON.stringify(retry));
  }
  const reopened = await boot("reopen");
  if (reopened.volume !== true || reopened.value !== 83) throw new Error("reopen failed after " + cut);
  if ((await boot(`compact-${cut}`)).cut !== cut) throw new Error("live compaction missed " + cut);
  const resumed = await boot("recover-live");
  const expectedGeneration = reopened.generation! + (published ? 1 : 0);
  if (resumed.generation !== expectedGeneration) throw new Error("incorrect live generation after " + cut);
  const compacted = await boot("compact");
  if (!published && compacted.reclaimed?.join() !== expected.join()) throw new Error("live staging leaked after " + cut);
  const confirmed = await boot("confirm-live");
  if (confirmed.generation !== expectedGeneration + 1 || confirmed.value !== 83) {
    throw new Error("compacted volume failed to reopen after " + cut);
  }
  if (cut === "target-reset") {
    await boot("verify-deferred");
    const failed = await boot("interrupt-writeback");
    if (failed.value !== 42 || (await boot("verify-writeback")).value !== 41) {
      throw new Error("interrupted buffered write failed to recover the acknowledged root");
    }
    const retried = await boot("retry-writeback");
    if (retried.value !== 42 || (await boot("verify-retried-writeback")).value !== 42) {
      throw new Error("retry lost an acknowledged sync after owner termination");
    }
    if (expectIndexAppendQuota && (failed.refusedAt !== "append" || retried.refusedAt !== "append")) {
      throw new Error("expected both quota refusals while building the final index");
    }
    console.log("KIFS sync quota recovery", { crash: failed.refusedAt, retry: retried.refusedAt });
  }
  if (cut === "both-controls-flushed") {
    const { physicalBefore, physicalAfter } = await boot("churn");
    if (!physicalBefore || !physicalAfter || physicalBefore <= 32 * 1024 * 1024 || physicalAfter >= physicalBefore / 4) {
      throw new Error("unexpected physical sizes after periodic compaction: " + [physicalBefore, physicalAfter]);
    }
    const next = await boot("confirm-live");
    if (next.generation !== confirmed.generation! + 1) throw new Error("periodic handoff was not durable");
    console.log("KIFS periodic compaction", { physicalBefore, physicalAfter });
  }
}
