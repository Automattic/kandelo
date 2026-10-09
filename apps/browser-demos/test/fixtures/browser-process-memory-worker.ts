import { BrowserProcessMemoryFactory } from "../../../../host/src/browser-process-memory-factory";
import { ProcessMemoryAllocator } from "../../../../host/src/process-memory";

self.onmessage = async (event: MessageEvent<4 | 8>) => {
  const factory = new BrowserProcessMemoryFactory();
  const allocator = new ProcessMemoryAllocator({
    maxMemories: 2,
    maxTotalBytes: 3 * 65536,
    createMemoryAsync: request => factory.allocate(request),
  });
  try {
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
