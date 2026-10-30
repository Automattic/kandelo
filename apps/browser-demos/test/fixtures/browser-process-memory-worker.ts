import { BrowserProcessMemoryFactory } from "../../../../host/src/browser-process-memory-factory";
import { ProcessMemoryAllocator } from "../../../../host/src/process-memory";

self.onmessage = async (event: MessageEvent<4 | 8 | "refusal" | "allocator-refusal">) => {
  const factory = new BrowserProcessMemoryFactory();
  const allocator = new ProcessMemoryAllocator({
    maxMemories: 2,
    maxTotalBytes: 3 * 65536,
    createMemoryAsync: request => factory.allocate(request),
  });
  try {
    if (event.data === "allocator-refusal") {
      const failing = new ProcessMemoryAllocator({
        maxMemories: 1, maxTotalBytes: 65536,
        createMemoryAsync: () => factory.allocate({ ptrWidth: 4, initialPages: 2, maximumPages: 1 }),
      });
      let failure: { name?: string; errno?: number } | undefined;
      try {
        await failing.acquireWhenAvailable({ ptrWidth: 4, initialPages: 1, maximumPages: 4 });
      } catch (error) {
        failure = error as { name?: string; errno?: number };
      }
      const result = { name: failure?.name, errno: failure?.errno, chargedBytes: failing.getRetirementStats().chargedBytes };
      failing.clear();
      self.postMessage(result);
      return;
    }
    if (event.data === "refusal") {
      let errorName: string | undefined;
      try {
        await factory.allocate({ ptrWidth: 4, initialPages: 2, maximumPages: 1 });
      } catch (error) {
        errorName = error instanceof Error ? error.name : String(error);
      }
      await new Promise(resolve => setTimeout(resolve, 0));
      const memory = await factory.allocate({ ptrWidth: 4, initialPages: 1, maximumPages: 4 });
      self.postMessage({ errorName, healthyBytes: memory.buffer.byteLength });
      return;
    }
    const parent = await allocator.acquireWhenAvailable({
      ptrWidth: event.data, initialPages: 1, maximumPages: 4,
    });
    new Uint8Array(parent.memory.buffer).fill(79);
    const cloned = allocator.acquireForkClone(parent.memory, event.data, 4);
    new Uint8Array(parent.memory.buffer).fill(33);
    parent.release();
    const child = await cloned;
    const captured = new Uint8Array(child.memory.buffer).every(byte => byte === 79);
    const oldPages = child.memory.grow(event.data === 8 ? 1n as unknown as number : 1);
    const bytes = child.memory.buffer.byteLength;
    child.release();
    allocator.clear();
    self.postMessage({ captured, oldPages: Number(oldPages), bytes });
  } catch (error) {
    self.postMessage({ error: String(error) });
  } finally {
    factory.dispose();
  }
};
