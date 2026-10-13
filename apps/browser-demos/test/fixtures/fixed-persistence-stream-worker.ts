import { saveFixedPersistenceImageStream } from "../../pages/kandelo/kernel-host/fixed-persistence-image";
import { OpfsImageReader } from "../../../../host/src/vfs/opfs-image-reader";

self.onmessage = (event: MessageEvent<
  | { name: string; identity: string }
  | { file: FileSystemFileHandle; length: number; chunkSha256: string[] }
>) => {
  void (async () => {
    try {
      if ("file" in event.data) {
        const reader = await OpfsImageReader.open(event.data.file, {
          length: event.data.length,
          chunkBytes: 1024 * 1024,
          chunkSha256: event.data.chunkSha256,
        });
        try {
          const first = new Uint8Array(3);
          const last = new Uint8Array(3);
          const firstRead = reader.readAt(0, first);
          const lastRead = reader.readAt(reader.length - 3, last);
          self.postMessage({ type: "read", first: [...first], last: [...last], firstRead, lastRead });
        } finally {
          reader.close();
        }
        return;
      }
      const first = new Uint8Array(1024 * 1024).fill(7);
      const saved = await saveFixedPersistenceImageStream(
        event.data.name,
        event.data.identity,
        [first, Uint8Array.of(1, 2, 3)],
        undefined,
        {
          imageConfig: { version: 1, defaultProfile: "probe", profiles: { probe: {} } },
          profileId: "probe",
          terminalSession: {
            kind: "kandelo-experimental-terminal-session",
            version: 1,
            initial: { path: "/bin/probe", argv: ["probe"], uid: 0, gid: 0 },
          },
          requiredServices: [],
        },
      );
      self.postMessage({ type: "done", file: saved.file, length: saved.length });
    } catch (error) {
      self.postMessage({ type: "error", message: String(error) });
    }
  })();
};
