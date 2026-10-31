import type { WorkerHandle } from "./worker-adapter";
import { POLICY_RECORD_BYTES, validPolicyRequest, type PolicyWorkerRequest, type PolicyWorkerResponse, type PolicyWorkerFailure } from "./program-policy-worker";

export type PolicyWorkerFactory = ((request: PolicyWorkerRequest) => WorkerHandle) & {
  readonly workspaceOverheadBytes: number;
  dispose?(): void | Promise<void>;
};
export class ProgramPolicyError extends Error {
  readonly reason: PolicyWorkerFailure | "busy" | "workspace" | "aborted" | "timeout" | "retirement" | "closed";
  constructor(reason: ProgramPolicyError["reason"], detail?: string) {
    super(`Program metadata inspection failed: ${reason}${detail ? ` (${detail.slice(0, 512)})` : ""}`);
    this.name = "ProgramPolicyError";
    this.reason = reason;
  }
}

export class ProgramPolicyInspector {
  private readonly factory: PolicyWorkerFactory;
  private readonly maximumJobs: number;
  private readonly maximumWorkspace: number;
  private activeJobs = 0;
  private activeWorkspace = 0;
  private closed = false;
  private readonly operations = new Set<Promise<Uint8Array>>();
  private readonly cancellations = new Set<() => void>();
  private readonly retirements = new Set<{ worker: WorkerHandle; workspace: number; onError?: (error: Error) => void; running?: Promise<void> }>();

  constructor(factory: PolicyWorkerFactory, limits: { maximumJobs: number; maximumWorkspace: number }) {
    if (![limits.maximumJobs, limits.maximumWorkspace].every(value => Number.isSafeInteger(value) && value > 0)
      || !Number.isSafeInteger(factory.workspaceOverheadBytes) || factory.workspaceOverheadBytes < 0) {
      throw new ProgramPolicyError("protocol");
    }
    this.factory = factory;
    this.maximumJobs = limits.maximumJobs;
    this.maximumWorkspace = limits.maximumWorkspace;
  }

  get active(): Readonly<{ jobs: number; workspace: number }> {
    return { jobs: this.activeJobs, workspace: this.activeWorkspace };
  }

  async drainRetirements(): Promise<void> {
    let failed = false;
    for (const entry of this.retirements) {
      const operation = entry.running ??= (async () => {
        await entry.worker.terminate();
        if (entry.onError) entry.worker.off("error", entry.onError as (...args: unknown[]) => void);
        this.retirements.delete(entry);
        this.activeJobs -= 1;
        this.activeWorkspace -= entry.workspace;
      })().finally(() => { entry.running = undefined; });
      try {
        await operation;
      } catch { failed = true; }
    }
    if (failed) throw new ProgramPolicyError("retirement");
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const cancel of this.cancellations) cancel();
    await Promise.allSettled([...this.operations]);
    await this.drainRetirements();
    if (this.activeJobs !== 0) throw new ProgramPolicyError("retirement");
    await this.factory.dispose?.();
  }

  inspect(request: PolicyWorkerRequest, options: { signal?: AbortSignal; timeoutMs: number }): Promise<Uint8Array> {
    const operation = this.run(request, options);
    this.operations.add(operation);
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
    return operation;
  }

  private async run(request: PolicyWorkerRequest, options: { signal?: AbortSignal; timeoutMs: number }): Promise<Uint8Array> {
    if (this.closed) throw new ProgramPolicyError("closed");
    if (!validPolicyRequest(request) || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 0x7fff_ffff) {
      throw new ProgramPolicyError("protocol");
    }
    if (options.signal?.aborted) throw new ProgramPolicyError("aborted");
    if (this.activeJobs >= this.maximumJobs) throw new ProgramPolicyError("busy");
    const workspace = request.memoryPages * 65536 + request.source.byteLength * 3
      + POLICY_RECORD_BYTES + this.factory.workspaceOverheadBytes;
    if (workspace > this.maximumWorkspace - this.activeWorkspace) throw new ProgramPolicyError("workspace");
    this.activeJobs += 1;
    this.activeWorkspace += workspace;
    let worker: WorkerHandle | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onMessage: ((response: unknown) => void) | undefined;
    let onError: ((error: Error) => void) | undefined;
    let onExit: ((code: number) => void) | undefined;
    let abort: (() => void) | undefined;
    try {
      let source: ArrayBuffer;
      try { source = request.source.slice(0); }
      catch (error) {
        if (error instanceof RangeError) throw new ProgramPolicyError("allocation", error.message);
        throw error;
      }
      worker = this.factory({
        module: request.module, source, metadataBytes: request.metadataBytes,
        workItems: request.workItems, memoryPages: request.memoryPages, heapBytes: request.heapBytes,
      });
      return await new Promise<Uint8Array>((resolve, reject) => {
        const fail = (reason: ProgramPolicyError["reason"], detail?: string) => reject(new ProgramPolicyError(reason, detail));
        onMessage = (message) => {
          const response = message as PolicyWorkerResponse;
          if (response?.kind === "inspection" && response.record instanceof Uint8Array
            && response.record.buffer instanceof ArrayBuffer && response.record.byteLength === POLICY_RECORD_BYTES
            && response.record.byteOffset === 0 && response.record.buffer.byteLength === POLICY_RECORD_BYTES) {
            resolve(response.record.slice());
          } else if (response?.kind === "failure" && ["invalid", "metadata-limit", "work-limit", "allocation", "trap", "protocol"].includes(response.reason)) {
            fail(response.reason, typeof response.detail === "string" ? response.detail : undefined);
          } else fail("protocol");
        };
        onError = (error) => fail("trap", error.message);
        onExit = (code) => fail("trap", `worker exited: ${code}`);
        abort = () => fail("aborted");
        this.cancellations.add(abort);
        worker!.on("message", onMessage);
        worker!.on("error", onError);
        worker!.on("exit", onExit);
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
        timer = setTimeout(() => fail("timeout"), options.timeoutMs);
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort) options.signal?.removeEventListener("abort", abort);
      if (abort) this.cancellations.delete(abort);
      if (worker) {
        if (onMessage) worker.off("message", onMessage as (...args: unknown[]) => void);
        if (onExit) worker.off("exit", onExit as (...args: unknown[]) => void);
        try { await worker.terminate(); }
        catch {
          this.retirements.add({ worker, workspace, onError });
          throw new ProgramPolicyError("retirement");
        }
        if (onError) worker.off("error", onError as (...args: unknown[]) => void);
      }
      this.activeJobs -= 1;
      this.activeWorkspace -= workspace;
    }
  }
}
