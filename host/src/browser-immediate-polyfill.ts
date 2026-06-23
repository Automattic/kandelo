type BrowserImmediateCallback = (...args: any[]) => void;

interface BrowserImmediateHandle {
  readonly __kandeloBrowserImmediate: true;
  readonly id: number;
}

interface BrowserImmediateGlobal {
  setImmediate?: unknown;
  clearImmediate?: unknown;
  MessageChannel: typeof MessageChannel;
}

function isBrowserImmediateHandle(value: unknown): value is BrowserImmediateHandle {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<BrowserImmediateHandle>).__kandeloBrowserImmediate === true
  );
}

export function installBrowserSetImmediatePolyfill(globalObject: BrowserImmediateGlobal = globalThis): void {
  if (typeof globalObject.setImmediate !== "undefined") return;

  const queue: Array<{
    handle: BrowserImmediateHandle;
    fn: BrowserImmediateCallback;
    args: any[];
  }> = [];
  const pending = new Set<BrowserImmediateHandle>();
  const cancelled = new Set<BrowserImmediateHandle>();
  let nextId = 0;
  let scheduled = false;
  let flushing = false;

  const channel = new globalObject.MessageChannel();
  channel.port1.onmessage = flush;

  function scheduleFlush(): void {
    if (scheduled) return;
    scheduled = true;
    channel.port2.postMessage(null);
  }

  function flush(): void {
    scheduled = false;
    flushing = true;

    const count = queue.length;
    for (let i = 0; i < count && queue.length > 0; i++) {
      const entry = queue.shift()!;
      pending.delete(entry.handle);
      if (cancelled.delete(entry.handle)) continue;

      try {
        entry.fn(...entry.args);
      } catch (e) {
        console.error("[setImmediate] callback threw:", e);
      }
    }

    flushing = false;
    if (queue.length > 0) scheduleFlush();
  }

  (globalObject as any).setImmediate = (fn: BrowserImmediateCallback, ...args: any[]) => {
    const handle: BrowserImmediateHandle = {
      __kandeloBrowserImmediate: true,
      id: ++nextId,
    };
    queue.push({ handle, fn, args });
    pending.add(handle);
    if (!flushing) scheduleFlush();
    return handle;
  };

  (globalObject as any).clearImmediate = (handle: unknown) => {
    if (!isBrowserImmediateHandle(handle) || !pending.has(handle)) return;
    cancelled.add(handle);
  };
}
