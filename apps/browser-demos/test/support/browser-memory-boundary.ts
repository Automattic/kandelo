import type { Page } from "@playwright/test";

/** Inspect actual worker messages without retaining their backing storage. */
export function persistentRealmMemoryFailures(
  message: unknown,
  Memory = WebAssembly.Memory,
): string[] {
  const failures: string[] = [];
  const visited = new Set<object>();
  const root = message as { type?: string; len?: number } | null;
  function visit(value: unknown, path: string): void {
    if (typeof value !== "object" || value === null || visited.has(value)) return;
    visited.add(value);
    if (value instanceof Memory) {
      failures.push(`${path}: whole WebAssembly.Memory reached browser main`);
      return;
    }
    if (value instanceof SharedArrayBuffer) {
      // Independently allocated device storage only: the pixel mirror and
      // the fixed query/creation mailbox. The latter is 20 header + 65536 payload
      // bytes, which cannot be a page-aligned Wasm memory backing buffer.
      // Provenance/reuse are also covered by the real forwarded-query test.
      const pixels = root?.type === "fb_bind" && path === "message.pixels"
        && value.byteLength === root.len;
      const query = (root?.type === "gl_forward_query" || root?.type === "gl_forward_create_context"
        || root?.type === "gl_forward_make_current")
        && path === "message.mailbox"
        && value.byteLength === 20 + 65536;
      if ((!pixels && !query)
          || (value as SharedArrayBuffer & { growable?: boolean }).growable) {
        failures.push(`${path}: unreviewed shared backing reached browser main`);
      }
      return;
    }
    if (ArrayBuffer.isView(value)) {
      if (value.buffer instanceof SharedArrayBuffer) {
        failures.push(`${path}: shared view retains its entire backing memory`);
      }
      return;
    }
    if (value instanceof ArrayBuffer) return;
    // Structured clone preserves Map/Set entries, which Object.entries omits.
    // Dynamic RPC results must not hide guest storage inside a container.
    if (value instanceof Map) {
      let index = 0;
      for (const [key, child] of value) {
        visit(key, `${path}.keys[${index}]`);
        visit(child, `${path}.values[${index++}]`);
      }
      return;
    }
    if (value instanceof Set) {
      let index = 0;
      for (const child of value) visit(child, `${path}[${index++}]`);
      return;
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
  }
  visit(message, "message");
  return failures;
}

declare global {
  interface Window {
    __browserMemoryBoundaryFailures?: string[];
    __browserMemoryBoundaryRealmId?: string;
  }
}

export async function installBrowserMemoryBoundaryProbe(page: Page): Promise<void> {
  function install(inspect: typeof persistentRealmMemoryFailures): void {
    const failures: string[] = window.__browserMemoryBoundaryFailures = [];
    window.__browserMemoryBoundaryRealmId = crypto.randomUUID();
    const NativeMemory = WebAssembly.Memory;
    const NativeWorker = window.Worker;
    WebAssembly.Memory = class extends NativeMemory {
      constructor(descriptor: WebAssembly.MemoryDescriptor) {
        super(descriptor);
        if (descriptor.shared) failures.push("browser main allocated shared Wasm memory");
      }
    };
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", event => {
          failures.push(...inspect(event.data, NativeMemory));
        });
      }
    };
  }
  // Both functions are self-contained. Inject before application imports so
  // aliases captured by the real host cannot bypass this test observation.
  await page.addInitScript({
    content: `(${install.toString()})(${persistentRealmMemoryFailures.toString()});`,
  });
}

export function memoryBoundaryFailures(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    if (!window.__browserMemoryBoundaryFailures) throw new Error("memory probe was not installed");
    return window.__browserMemoryBoundaryFailures;
  });
}

export function memoryBoundaryRealmId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const id = window.__browserMemoryBoundaryRealmId;
    if (!id) throw new Error("memory probe was not installed");
    return id;
  });
}
