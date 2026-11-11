import inspector from "node:inspector";

export interface WorkerDebugTarget {
  readonly id: string;
  readonly url: string;
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}
export interface DebugEvent { method: string; params?: any }
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/** Local inspector transport: no listening socket, guest memory, or kernel work on main. */
export class NodeWorkerDebugger {
  private readonly session = new inspector.Session();
  private readonly targets = new Map<string, WorkerDebugTarget & { pending: Map<number, Pending> }>();
  private sequence = 0;
  private closed = false;
  private closing?: Promise<void>;
  private rejectFailure!: (error: Error) => void;
  readonly failure = new Promise<never>((_resolve, reject) => { this.rejectFailure = reject; });
  constructor(private readonly callbacks: {
    ready(target: WorkerDebugTarget): Promise<void>;
    event(target: WorkerDebugTarget, event: DebugEvent): Promise<void>;
    retired?(target: WorkerDebugTarget): void;
  }) {
    // The caller races failure against program exit. Register a handler now
    // too, because a worker can fail during asynchronous host initialization.
    void this.failure.catch(() => {});
    this.session.connect();
    this.session.on("inspectorNotification", event => this.receive(event));
  }
  private post(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error("debugger is closed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`inspector ${method}: response deadline`)), 5000);
      this.session.post(method, params, (error, result) => {
        clearTimeout(timer);
        error ? reject(error) : resolve(result);
      });
    });
  }
  private background(work: Promise<unknown>, sessionId: string): void {
    void work.catch(error => {
      if (!this.closed && !this.closing && this.targets.has(sessionId))
        this.rejectFailure(error instanceof Error ? error : new Error(String(error)));
    });
  }
  private receive(event: DebugEvent): void {
    const params = event.params;
    if (event.method === "NodeWorker.attachedToWorker") {
      const sessionId = params.sessionId as string;
      const pending = new Map<number, Pending>();
      const target = {
        id: String(params.workerInfo.workerId),
        url: String(params.workerInfo.url),
        pending,
        send: <T>(method: string, values: Record<string, unknown> = {}) => new Promise<T>((resolve, reject) => {
          if (this.closed || !this.targets.has(sessionId)) { reject(new Error("debug target retired")); return; }
          if (pending.size >= 64) { reject(new Error("debugger request budget exceeded")); return; }
          const id = ++this.sequence;
          const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: response deadline`)); }, 5000);
          pending.set(id, { resolve: value => resolve(value as T), reject, timer });
          void this.post("NodeWorker.sendMessageToWorker", { sessionId, message: JSON.stringify({ id, method, params: values }) })
            .catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
        }),
      };
      this.targets.set(sessionId, target);
      this.background((async () => {
        try { await target.send("Debugger.enable"); await this.callbacks.ready(target); }
        finally { await target.send("Runtime.runIfWaitingForDebugger"); }
      })(), sessionId);
    } else if (event.method === "NodeWorker.receivedMessageFromWorker") {
      const target = this.targets.get(params.sessionId);
      if (!target) return;
      let message: any;
      try { message = JSON.parse(params.message); } catch (error) { this.rejectFailure(new Error(`malformed inspector message: ${error}`)); return; }
      if (message.id !== undefined) {
        const waiter = target.pending.get(message.id);
        if (waiter) {
          clearTimeout(waiter.timer); target.pending.delete(message.id);
          message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
        }
      } else if (!this.closing) this.background(this.callbacks.event(target, message), params.sessionId);
    } else if (event.method === "NodeWorker.detachedFromWorker") {
      const target = this.targets.get(params.sessionId);
      if (target) for (const waiter of target.pending.values()) {
        clearTimeout(waiter.timer); waiter.reject(new Error("debug target retired"));
      }
      this.targets.delete(params.sessionId);
      if (target) this.callbacks.retired?.(target);
    }
  }
  async start(): Promise<void> {
    // Node reports nested workers through this root domain. Child sessions
    // have no NodeWorker domain. Each initial "Break on start" still needs
    // an explicit resume after Runtime.runIfWaitingForDebugger.
    await this.post("NodeWorker.enable", { waitForDebuggerOnStart: true });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.detachAll();
    return this.closing;
  }
  private async detachAll(): Promise<void> {
    try {
      await this.post("NodeWorker.disable");
      const detached = await Promise.allSettled([...this.targets].map(async ([sessionId, target]) => {
        // A worker may be waiting before startup or stopped at a breakpoint.
        // Root disconnect alone does not detach its remote worker sessions.
        await target.send("Runtime.runIfWaitingForDebugger").catch(() => {});
        await target.send("Debugger.resume").catch(() => {});
        await this.post("NodeWorker.detach", { sessionId });
      }));
      const failed = detached.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } finally {
      this.closed = true;
      this.session.disconnect();
      for (const target of this.targets.values()) {
        for (const waiter of target.pending.values()) {
          clearTimeout(waiter.timer); waiter.reject(new Error("debugger closed"));
        }
        this.callbacks.retired?.(target);
      }
      this.targets.clear();
    }
  }
}
