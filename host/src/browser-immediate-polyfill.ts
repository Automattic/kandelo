type BrowserImmediateCallback = (...args: any[]) => void;

interface BrowserImmediateHandle {
  readonly id: number;
}

interface BrowserImmediateEntry {
  handle: BrowserImmediateHandle;
  fn: BrowserImmediateCallback;
  args: any[];
  cancelled: boolean;
}

export interface BrowserImmediatePolyfillTarget {
  setImmediate?: unknown;
  clearImmediate?: unknown;
  MessageChannel: typeof MessageChannel;
}

export interface BrowserImmediatePolyfillState {
  pendingCount(): number;
  queueLength(): number;
}

/**
 * Install the MessageChannel-backed setImmediate used by the browser kernel
 * worker. Handles are opaque objects so clearImmediate cannot confuse a
 * browser setTimeout's numeric handle with one of this polyfill's handles.
 */
export function installBrowserSetImmediatePolyfill(
  target: BrowserImmediatePolyfillTarget = globalThis,
): BrowserImmediatePolyfillState | null {
  if (typeof target.setImmediate !== "undefined") {
    return null;
  }

  const queue: BrowserImmediateEntry[] = [];
  const pending = new Map<BrowserImmediateHandle, BrowserImmediateEntry>();
  let nextId = 0;
  let scheduled = false;
  let flushing = false;

  const channel = new target.MessageChannel();
  channel.port1.onmessage = flush;

  function scheduleFlush(): void {
    if (scheduled || flushing) {
      return;
    }
    scheduled = true;
    channel.port2.postMessage(null);
  }

  function flush(): void {
    scheduled = false;
    flushing = true;

    // Process only items queued at flush start. Items added during this flush
    // are deferred to a new macrotask so onmessage handlers can interleave.
    const count = queue.length;
    for (let i = 0; i < count && queue.length > 0; i++) {
      const entry = queue.shift()!;
      pending.delete(entry.handle);
      if (entry.cancelled) {
        continue;
      }

      try {
        entry.fn(...entry.args);
      } catch (error) {
        console.error("[setImmediate] callback threw:", error);
      }
    }

    flushing = false;
    if (queue.length > 0) {
      scheduleFlush();
    }
  }

  (target as any).setImmediate = (fn: BrowserImmediateCallback, ...args: any[]) => {
    const handle: BrowserImmediateHandle = { id: ++nextId };
    const entry: BrowserImmediateEntry = {
      handle,
      fn,
      args,
      cancelled: false,
    };
    queue.push(entry);
    pending.set(handle, entry);
    scheduleFlush();
    return handle;
  };

  (target as any).clearImmediate = (handle: unknown) => {
    if (typeof handle !== "object" || handle === null) {
      return;
    }

    const entry = pending.get(handle as BrowserImmediateHandle);
    if (entry === undefined) {
      return;
    }

    entry.cancelled = true;
    pending.delete(entry.handle);
  };

  return {
    pendingCount: () => pending.size,
    queueLength: () => queue.length,
  };
}
