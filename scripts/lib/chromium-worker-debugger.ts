import type { WorkerDebugTarget, DebugEvent } from './node-worker-debugger';
import type { RustDebugCallbacks } from './rust-debug-session';

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface Channel extends WorkerDebugTarget {
  parent?: Channel;
  sessionId?: string;
  children: Map<string, Channel>;
  pending: Map<number, Pending>;
}
interface CdpSession {
  send(method: any, params?: any): Promise<any>;
  on(event: any, listener: (params: any) => void): unknown;
  detach(): Promise<void>;
}

/** Chromium CDP adapter for dedicated workers, including process subworkers. */
export class ChromiumWorkerDebugger {
  private readonly root: Channel;
  private readonly channels = new Set<Channel>();
  private sequence = 0;
  private closing?: Promise<void>;
  private rejectFailure!: (error: Error) => void;
  readonly failure = new Promise<never>((_resolve, reject) => { this.rejectFailure = reject; });
  constructor(private readonly session: CdpSession, private readonly callbacks: RustDebugCallbacks) {
    void this.failure.catch(() => {});
    this.root = { id: 'page', url: '', children: new Map(), pending: new Map(),
      send: (method, params = {}) => this.post(method, params) };
    for (const method of ['Target.attachedToTarget', 'Target.receivedMessageFromTarget', 'Target.detachedFromTarget']) {
      session.on(method, params => this.receive(this.root, { method, params }));
    }
  }
  private async post<T>(method: string, params: Record<string, unknown>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.session.send(method, params),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`CDP ${method}: response deadline`)), 5000);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }
  private background(work: Promise<unknown>, channel: Channel): void {
    void work.catch(error => {
      if (!this.closing && this.channels.has(channel)) this.rejectFailure(error instanceof Error ? error : new Error(String(error)));
    });
  }
  private retire(channel: Channel): void {
    for (const child of channel.children.values()) this.retire(child);
    channel.children.clear();
    for (const pending of channel.pending.values()) {
      clearTimeout(pending.timer); pending.reject(new Error('debug target retired'));
    }
    channel.pending.clear(); this.channels.delete(channel); this.callbacks.retired(channel);
  }
  private receive(channel: Channel, event: DebugEvent & { id?: number; result?: unknown; error?: unknown }): void {
    if (event.id !== undefined) {
      const pending = channel.pending.get(event.id);
      if (pending) {
        clearTimeout(pending.timer); channel.pending.delete(event.id);
        event.error ? pending.reject(new Error(JSON.stringify(event.error))) : pending.resolve(event.result);
      }
      return;
    }
    const params = event.params;
    if (event.method === 'Target.attachedToTarget') {
      if (this.channels.size >= 128) { this.rejectFailure(new Error('debug worker budget exceeded')); return; }
      const child: Channel = {
        id: `${channel.id}/${params.targetInfo.targetId}`, url: String(params.targetInfo.url),
        parent: channel, sessionId: params.sessionId, children: new Map(), pending: new Map(),
        send: <T>(method: string, values: Record<string, unknown> = {}) => new Promise<T>((resolve, reject) => {
          if (!this.channels.has(child)) { reject(new Error('debug target retired')); return; }
          if (child.pending.size >= 64) { reject(new Error('debugger request budget exceeded')); return; }
          const id = ++this.sequence;
          const timer = setTimeout(() => { child.pending.delete(id); reject(new Error(`${method}: response deadline`)); }, 5000);
          child.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
          void channel.send('Target.sendMessageToTarget', { sessionId: child.sessionId, message: JSON.stringify({ id, method, params: values }) })
            .catch(error => { clearTimeout(timer); child.pending.delete(id); reject(error); });
        }),
      };
      channel.children.set(params.sessionId, child); this.channels.add(child);
      this.background((async () => {
        try {
          await child.send('Debugger.enable');
          await child.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
          await this.callbacks.ready(child);
        } finally { await child.send('Runtime.runIfWaitingForDebugger'); }
      })(), child);
    } else if (event.method === 'Target.receivedMessageFromTarget') {
      const child = channel.children.get(params.sessionId);
      if (child) {
        try { this.receive(child, JSON.parse(params.message)); }
        catch (error) { this.rejectFailure(new Error(`malformed CDP worker message: ${error}`)); }
      }
    } else if (event.method === 'Target.detachedFromTarget') {
      const child = channel.children.get(params.sessionId);
      if (child) { channel.children.delete(params.sessionId); this.retire(child); }
    } else if (!this.closing) this.background(this.callbacks.event(channel, event), channel);
  }
  async start(): Promise<void> {
    await this.root.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
  }
  close(): Promise<void> {
    if (!this.closing) this.closing = this.detachAll();
    return this.closing;
  }
  private async detachAll(): Promise<void> {
    try {
      await this.root.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: false });
      const detach = async (channel: Channel): Promise<void> => {
        await Promise.all([...channel.children.values()].map(detach));
        if (!this.channels.has(channel)) return;
        await channel.send('Runtime.runIfWaitingForDebugger').catch(() => {});
        await channel.send('Debugger.resume').catch(() => {});
        await channel.parent!.send('Target.detachFromTarget', { sessionId: channel.sessionId }).catch(error => {
          if (this.channels.has(channel)) throw error;
        });
      };
      await Promise.all([...this.root.children.values()].map(detach));
    } finally {
      try { await this.session.detach(); }
      finally {
        for (const channel of [...this.channels]) this.retire(channel);
        this.root.children.clear();
      }
    }
  }
}
