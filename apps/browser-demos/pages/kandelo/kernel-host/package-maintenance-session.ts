import { checkedPackageMaintenanceResponse, PackageMaintenanceError, type PackageMaintenanceRequest, type PackageMaintenanceResponse } from "../../../../../host/src/package-maintenance";
import { ERRNO } from "../../../../../host/src/generated/abi";
import { PACKAGE_MAINTENANCE_WIRE as wire } from "../../../../../host/src/generated/abi";
import { INCOMPATIBLE_SOFTWARE, NOT_UPDATABLE_SOFTWARE, type ComputerSoftwareSnapshot, type SoftwareOperation, type SoftwareRecovery } from "../../../../../web-libs/kandelo-session/src/computer-software";
import { PackageUpgradeClient, PackageUpgradeFinalizationError, type PackageUpgradeSource } from "./package-upgrade-client";

export interface OwnedPackageSource {
  source: PackageUpgradeSource;
  close(): Promise<void>;
  prepare?(): Promise<void>;
  committed?(): Promise<void>;
}

type Runtime = { packageMaintenance(request: PackageMaintenanceRequest): Promise<PackageMaintenanceResponse> };

function recoveryName(value: number): SoftwareRecovery {
  switch (value) {
    case wire.RECOVERY_NONE: return "none";
    case wire.RECOVERY_INCOMPLETE: return "incomplete";
    case wire.RECOVERY_PENDING: return "pending";
    case wire.RECOVERY_ACTIVE: return "active";
    case wire.RECOVERY_ROLLED_BACK: return "rolled-back";
    default: throw new Error("Kernel returned an unknown package recovery state");
  }
}

export class PackageMaintenanceSession {
  private state: ComputerSoftwareSnapshot = { available: true, targetAvailable: false, maintenance: true,
    busy: false, recovery: "unknown", operation: null, progress: null, error: null };
  private readonly listeners = new Set<() => void>();
  private activeTask: Promise<void> | undefined;
  private cancellation: AbortController | undefined;
  private retiring = false;
  private released = false;
  private poisoned = false;
  private closing: Promise<void> | undefined;

  private constructor(private readonly runtime: Runtime, private readonly assertCurrent: () => void) {}

  static async open(runtime: Runtime, assertCurrent: () => void, bootBlocked = false, updatable = true): Promise<PackageMaintenanceSession> {
    const session = new PackageMaintenanceSession(runtime, assertCurrent);
    await session.call({ action: "enter" });
    try { await session.inspect(); }
    catch { }
    const { recovery } = session.state;
    if (bootBlocked && (recovery === "none" || recovery === "active" || recovery === "rolled-back")) session.publish({ incompatible: true, updatable });
    return session;
  }

  getSnapshot(): ComputerSoftwareSnapshot {
    return { ...this.state, progress: this.state.progress === null ? null : { ...this.state.progress } };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private publish(patch: Partial<ComputerSoftwareSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { console.warn("Package maintenance observer failed", error); }
    }
  }

  private async call(request: PackageMaintenanceRequest): Promise<PackageMaintenanceResponse> {
    if (request.action !== "cancel") this.assertCurrent();
    return checkedPackageMaintenanceResponse(await this.runtime.packageMaintenance(request));
  }

  private async inspect(): Promise<void> {
    try { this.publish({ recovery: recoveryName((await this.call({ action: "recovery" })).status) }); }
    catch (error) { this.publish({ recovery: "unknown", error: this.state.error ?? String(error) }); throw error; }
  }

  run(operation: "install" | "resume" | "rollback", openSource?: (signal: AbortSignal) => Promise<OwnedPackageSource>): Promise<void> {
    if (operation !== "rollback" && openSource === undefined) return Promise.reject(new Error("This update requires its verified software source"));
    return this.perform(operation, async signal => {
      let source: OwnedPackageSource | undefined;
      let failure: { error: unknown } | undefined;
      try {
        if (operation !== "rollback") source = await openSource!(signal);
        signal.throwIfAborted();
        await source?.prepare?.();
        signal.throwIfAborted();
        const client = new PackageUpgradeClient(request => this.call(request));
        await client.run(operation, source?.source, {
          signal,
          replacesRollback: this.state.recovery === "active" || this.state.recovery === "rolled-back",
          onProgress: progress => this.publish({ progress: {
            files: progress.files, installedVerified: progress.installedVerified, stagedVerified: progress.stagedVerified,
            path: progress.path, completed: progress.verifiedBytes.toString(), total: progress.totalBytes.toString(),
          } }),
          onTransfer: progress => this.publish({ progress: { ...(this.state.progress ?? {
            files: 0, installedVerified: 0, stagedVerified: 0, path: "", completed: "0", total: "0" }),
            path: progress.path ?? "Software inventory", completed: String(progress.accepted), total: String(progress.total) } }),
        });
        if (operation !== "rollback") this.publish({ incompatible: false });
      } catch (error) {
        failure = { error };
        if (error instanceof PackageUpgradeFinalizationError || (error as { retainTarget?: unknown } | null)?.retainTarget === true) this.poisoned = true;
        throw error;
      } finally {
        try { await source?.close(); }
        catch (cleanup) {
          this.poisoned = true;
          throw failure === undefined ? cleanup : new AggregateError([failure.error, cleanup], "Package update and source cleanup failed");
        }
        if (failure === undefined && source?.committed !== undefined) {
          try { await source.committed(); }
          catch (error) { console.warn("Software updated, but unused package-source cleanup failed", error); }
        }
      }
    });
  }

  discard(): Promise<void> { return this.perform("discard", async () => { await this.call({ action: "cancel" }); await this.call({ action: "discard" }); }); }
  refresh(): Promise<void> { return this.perform("inspect", async () => {}); }

  release(): Promise<void> {
    return this.perform("release", async () => {
      try { await this.call({ action: "leave" }); }
      catch (error) {
        const notUpdatable = this.state.updatable === false;
        if (!(error instanceof PackageMaintenanceError) || (error.errno !== ERRNO.ENOEXEC && !notUpdatable)) throw error;
        this.publish({ incompatible: true });
        throw new Error(notUpdatable ? NOT_UPDATABLE_SOFTWARE : INCOMPATIBLE_SOFTWARE, { cause: error });
      }
      this.released = true;
      this.publish({ maintenance: false });
    });
  }

  private perform(operation: SoftwareOperation, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.retiring || this.released || this.poisoned) return Promise.reject(new Error("Maintenance is closed or cleanup is unconfirmed; reopen the computer"));
    if (this.activeTask !== undefined) return Promise.reject(new Error("A maintenance operation is already running"));
    this.cancellation = new AbortController();
    const signal = this.cancellation.signal;
    const task = Promise.resolve().then(async () => {
      try { this.assertCurrent(); signal.throwIfAborted(); await work(signal); }
      catch (error) { this.publish({ error: String(error) }); throw error; }
      finally {
        if (!this.released) {
          try { await this.inspect(); }
          catch { }
        }
      }
    }).finally(() => {
      this.activeTask = undefined;
      this.cancellation = undefined;
      this.publish({ busy: false, operation: null });
    });
    this.activeTask = task;
    this.publish({ busy: true, operation, progress: null, error: null });
    return task;
  }

  cancel(): void { this.cancellation?.abort(new DOMException("Package operation cancelled; inspect recovery before restarting", "AbortError")); }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.retiring = true;
    this.cancel();
    this.closing = (async () => {
      await this.activeTask?.catch(() => {});
      if (!this.released) await this.call({ action: "cancel" });
      if (this.poisoned) throw new Error("Package maintenance cleanup is unconfirmed; retain the computer and source until reload");
    })();
    return this.closing;
  }
}
