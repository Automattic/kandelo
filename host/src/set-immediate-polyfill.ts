export type ImmediateCallback = (...args: any[]) => void;

export interface ImmediatePolyfillTarget {
  setImmediate?: (fn: ImmediateCallback, ...args: any[]) => number;
  clearImmediate?: (id: number) => void;
  MessageChannel: typeof MessageChannel;
}

export interface ImmediatePolyfillState {
  pendingCount(): number;
  queueLength(): number;
}

interface ImmediateEntry {
  id: number;
  fn: ImmediateCallback;
  args: any[];
  cancelled: boolean;
}

/**
 * Install a browser-worker setImmediate polyfill that matches native
 * clearImmediate semantics: clearing an already-fired or unknown handle is a
 * no-op, not a retained cancellation record.
 */
export function installSetImmediatePolyfill(
  target: ImmediatePolyfillTarget = globalThis as typeof globalThis & ImmediatePolyfillTarget,
): ImmediatePolyfillState | null {
  if (typeof target.setImmediate !== "undefined") {
    return null;
  }

  const queue: ImmediateEntry[] = [];
  const pending = new Map<number, ImmediateEntry>();
  let nextId = 0;
  let scheduled = false;
  let flushing = false;

  const channel = new target.MessageChannel();
  channel.port1.onmessage = flush;

  function scheduleFlush() {
    if (!scheduled && !flushing) {
      scheduled = true;
      channel.port2.postMessage(null);
    }
  }

  function flush() {
    scheduled = false;
    flushing = true;
    // Process only items queued at flush start. Items added during this flush
    // are deferred to a new macrotask so onmessage handlers can interleave.
    const count = queue.length;
    for (let i = 0; i < count && queue.length > 0; i++) {
      const entry = queue.shift()!;
      pending.delete(entry.id);
      if (entry.cancelled) {
        continue;
      }
      try {
        entry.fn(...entry.args);
      } catch (e) {
        console.error("[setImmediate] callback threw:", e);
      }
    }
    flushing = false;
    if (queue.length > 0) {
      scheduleFlush();
    }
  }

  target.setImmediate = (fn: ImmediateCallback, ...args: any[]) => {
    const id = ++nextId;
    const entry: ImmediateEntry = { id, fn, args, cancelled: false };
    queue.push(entry);
    pending.set(id, entry);
    scheduleFlush();
    return id;
  };

  target.clearImmediate = (id: number) => {
    const entry = pending.get(id);
    if (entry === undefined) {
      return;
    }
    entry.cancelled = true;
    pending.delete(id);
  };

  return {
    pendingCount: () => pending.size,
    queueLength: () => queue.length,
  };
}
