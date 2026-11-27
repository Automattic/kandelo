import { compareNamespaces, measureNamespace, type PositionedFile } from "../../../../benchmarks/namespace-storage";

async function run(bytes: ArrayBuffer) {
  const opfs = await navigator.storage.getDirectory();
  const name = `namespace-bench-${crypto.randomUUID()}`;
  const directory = await opfs.getDirectoryHandle(name, { create: true });
  try {
    const module = await WebAssembly.compile(bytes);
    let caseNumber = 0;
    const samples = await compareNamespaces(async (format, files, seed) => {
      const handles: FileSystemSyncAccessHandle[] = [];
      try {
        const slots: PositionedFile[] = [];
        for (let slot = 0; slot < 3; slot++) {
          const file = await directory.getFileHandle(`${caseNumber}-${slot}`, { create: true });
          const access = await file.createSyncAccessHandle();
          handles.push(access);
          slots.push({
            size: () => access.getSize(),
            read: (offset, bytes) => access.read(bytes, { at: offset }),
            write: (offset, bytes) => access.write(bytes, { at: offset }),
            flush: () => access.flush(),
            truncate: length => access.truncate(length),
          });
        }
        return await measureNamespace(module, slots, format, files, seed);
      } finally {
        for (const handle of handles) handle.close();
        caseNumber++;
      }
    });
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      byte => byte.toString(16).padStart(2, "0")).join("");
    return { backend: "OPFS synchronous access handles", userAgent: navigator.userAgent, sha256, samples };
  } finally {
    await opfs.removeEntry(name, { recursive: true });
  }
}

self.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
  void run(data).then(
    result => self.postMessage(result),
    error => self.postMessage({ error: error instanceof Error ? error.stack ?? error.message : String(error) }),
  );
};
