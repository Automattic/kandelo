import { PACKAGE_MAINTENANCE_WIRE as wire } from "../../../../../host/src/generated/abi";
import { checkedPackageMaintenanceResponse, type PackageMaintenanceRequest,
  type PackageMaintenanceResponse } from "../../../../../host/src/package-maintenance";

type Transport = (request: PackageMaintenanceRequest) => Promise<PackageMaintenanceResponse>;

export interface PackageUpgradeSource {
  inventoryBytes: number;
  readInventory(offset: number, length: number): Promise<Uint8Array>;
  readFile(path: string, offset: number, length: number): Promise<Uint8Array>;
}

export interface PackageUpgradeProgress {
  phase: number;
  files: number;
  installedVerified: number;
  stagedVerified: number;
  path: string;
  verifiedBytes: bigint;
  totalBytes: bigint;
}

interface Hooks {
  signal?: AbortSignal;
  onProgress?: (progress: PackageUpgradeProgress) => void;
  onTransfer?: (progress: { path: string | null; accepted: number; total: number }) => void;
}

function view(bytes: Uint8Array, minimum: number): DataView {
  if (bytes.length < minimum) throw new Error("Truncated package maintenance reply");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function packageUpgradeProgress(bytes: Uint8Array): PackageUpgradeProgress {
  const data = view(bytes, wire.PROGRESS_HEADER_BYTES);
  const pathLength = data.getUint32(wire.PROGRESS_PATH_LENGTH_OFFSET, true);
  const files = data.getUint32(wire.PROGRESS_FILE_COUNT_OFFSET, true);
  const installedVerified = data.getUint32(wire.PROGRESS_INSTALLED_COUNT_OFFSET, true);
  const stagedVerified = data.getUint32(wire.PROGRESS_STAGED_COUNT_OFFSET, true);
  const phase = data.getUint32(wire.PROGRESS_PHASE_OFFSET, true);
  if (data.getUint32(wire.PROGRESS_VERSION_OFFSET, true) !== wire.VERSION ||
      phase > wire.PHASE_ROLLED_BACK || files > 65536 || installedVerified > files || stagedVerified > files ||
      pathLength > 4096 || bytes.length !== wire.PROGRESS_HEADER_BYTES + pathLength) {
    throw new Error("Invalid package maintenance progress");
  }
  return { phase, files, installedVerified, stagedVerified,
    path: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(wire.PROGRESS_HEADER_BYTES)),
    verifiedBytes: data.getBigUint64(wire.PROGRESS_VERIFIED_BYTES_OFFSET, true),
    totalBytes: data.getBigUint64(wire.PROGRESS_TOTAL_BYTES_OFFSET, true) };
}

function checkChunk(bytes: Uint8Array, maximum: number): void {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > maximum || bytes.buffer.byteLength > wire.MAX_BUFFER_BYTES ||
      (typeof SharedArrayBuffer !== "undefined" && bytes.buffer instanceof SharedArrayBuffer)) {
    throw new Error("Package source returned an invalid bounded chunk");
  }
}

export class PackageUpgradeClient {
  private busy = false;
  private touched = false;
  private cleanupFailed = false;

  constructor(private readonly transport: Transport) {}

  private async call(request: PackageMaintenanceRequest, hooks: Hooks): Promise<PackageMaintenanceResponse> {
    hooks.signal?.throwIfAborted();
    this.touched = true;
    const response = checkedPackageMaintenanceResponse(await this.transport(request));
    hooks.signal?.throwIfAborted();
    return response;
  }

  private async progress(hooks: Hooks): Promise<PackageUpgradeProgress> {
    const progress = packageUpgradeProgress((await this.call({ action: "progress" }, hooks)).data);
    hooks.onProgress?.(progress);
    return progress;
  }

  private async verify(action: "verifyInstalled" | "verifyStaged", hooks: Hooks): Promise<void> {
    let steps = 0;
    for (;;) {
      const response = await this.call({ action, index: wire.MAX_BUFFER_BYTES }, hooks);
      if (response.status !== 0 && response.status !== 1) throw new Error("Invalid package verification status");
      if (++steps % 64 === 0 || response.status === 1) await this.progress(hooks);
      if (response.status === 1) return;
    }
  }

  private async stage(source: PackageUpgradeSource, files: number, restart: boolean, hooks: Hooks): Promise<void> {
    for (let index = 0; index < files; index++) {
      const bytes = (await this.call({ action: "stagingFile", index }, hooks)).data;
      const data = view(bytes, wire.STAGING_HEADER_BYTES);
      const kind = data.getUint32(wire.STAGING_KIND_OFFSET, true);
      const length = data.getUint32(wire.STAGING_PATH_LENGTH_OFFSET, true);
      if (length > 4096 || bytes.length !== wire.STAGING_HEADER_BYTES + length) throw new Error("Invalid package staging path");
      if (kind === wire.STAGING_REMOVED) continue;
      if (restart) await this.call({ action: "restartStagingFile", index }, hooks);
      if (kind === wire.STAGING_KERNEL) {
        await this.call({ action: "stage", index }, hooks);
        continue;
      }
      if (kind !== wire.STAGING_UPLOAD) throw new Error("Unknown package staging operation");
      const total = data.getBigUint64(wire.STAGING_SIZE_OFFSET, true);
      if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Package staging length exceeds the transport range");
      const size = Number(total);
      const path = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(wire.STAGING_HEADER_BYTES));
      let offset = 0;
      do {
        hooks.signal?.throwIfAborted();
        const amount = Math.min(wire.MAX_BUFFER_BYTES, size - offset);
        const chunk = amount === 0 ? new Uint8Array() : await source.readFile(path, offset, amount);
        if (amount !== 0) checkChunk(chunk, amount);
        const accepted = (await this.call({ action: "stage", index, offset, data: chunk }, hooks)).status;
        if (!Number.isInteger(accepted) || accepted < 0 || accepted > chunk.length || (chunk.length > 0 && accepted === 0)) {
          throw new Error("Package staging made invalid progress");
        }
        offset += accepted;
        hooks.onTransfer?.({ path, accepted: offset, total: size });
      } while (offset < size);
    }
  }

  async run(operation: "install" | "resume" | "rollback", source?: PackageUpgradeSource, hooks: Hooks = {}): Promise<PackageUpgradeProgress> {
    if (this.busy) throw new Error("A package operation is already running");
    if (this.cleanupFailed) throw new Error("Maintenance cleanup is unconfirmed; reopen the computer before retrying");
    if (operation !== "install" && operation !== "resume" && operation !== "rollback") throw new Error("Unknown package operation");
    if (operation !== "rollback" && !source) throw new Error("Package operation requires its software source");
    this.busy = true;
    this.touched = false;
    let commitAcknowledged = false;
    let operationFailed = false;
    let operationError: unknown;
    try {
      if (operation === "install") {
        const size = source!.inventoryBytes;
        if (!Number.isSafeInteger(size) || size < 1 || size > 8 * 1024 * 1024) throw new Error("Invalid package inventory length");
        for (let offset = 0; offset < size;) {
          hooks.signal?.throwIfAborted();
          const amount = Math.min(wire.MAX_BUFFER_BYTES, size - offset);
          const bytes = await source!.readInventory(offset, amount);
          checkChunk(bytes, amount);
          const response = await this.call({ action: "uploadInventory", offset, data: bytes }, hooks);
          if (response.status !== offset + bytes.length) throw new Error("Package inventory made invalid progress");
          offset = response.status;
          hooks.onTransfer?.({ path: null, accepted: offset, total: size });
        }
        await this.call({ action: "begin" }, hooks);
      } else {
        await this.call({ action: "cancel" }, hooks);
        await this.call({ action: "resume" }, hooks);
      }
      const progress = await this.progress(hooks);
      const phase = operation === "rollback" ? wire.PHASE_ACTIVE : wire.PHASE_PENDING;
      if (progress.phase !== phase) throw new Error("The recovered package phase does not permit this operation");
      await this.verify("verifyInstalled", hooks);
      if (operation !== "rollback") {
        if (operation === "install") await this.call({ action: "prepare" }, hooks);
        await this.stage(source!, progress.files, operation === "resume", hooks);
      }
      await this.verify("verifyStaged", hooks);
      hooks.signal?.throwIfAborted();
      const finishing = { ...hooks, signal: undefined };
      await this.call({ action: "commit" }, finishing);
      commitAcknowledged = true;
      const committed = await this.progress(finishing);
      return committed;
    } catch (error) {
      operationFailed = true;
      operationError = error;
      if (commitAcknowledged) throw new PackageUpgradeFinalizationError(true, { cause: error });
      throw error;
    } finally {
      try {
        if (this.touched) checkedPackageMaintenanceResponse(await this.transport({ action: "cancel" }));
      } catch (cleanupError) {
        this.cleanupFailed = true;
        const cause = operationFailed ? new AggregateError([operationError, cleanupError]) : cleanupError;
        throw new PackageUpgradeFinalizationError(commitAcknowledged, { cause });
      } finally { this.busy = false; this.touched = false; }
    }
  }
}

export class PackageUpgradeFinalizationError extends Error {
  constructor(readonly commitAcknowledged: boolean, options: ErrorOptions) {
    super(commitAcknowledged
      ? "The package commit was acknowledged, but maintenance finalization failed; inspect recovery before retrying"
      : "Package maintenance cleanup is unconfirmed; reopen the computer before retrying", options);
  }
}
