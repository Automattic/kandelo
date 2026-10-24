import { saveFixedPersistenceImageStream } from "../../pages/kandelo/kernel-host/fixed-persistence-image";
import { OpfsImageReader } from "../../../../host/src/vfs/opfs-image-reader";
import type { PersistentImageIntegrityPolicy } from "../../../../images/vfs/lib/kandelo-image-fs";
import { inspectPersistentImageFile } from "../../pages/kandelo/kernel-host/persistent-image-codec";
import { loadPositionedImageWriterModuleBytes } from "../../lib/kernel-owned-boot";

self.onmessage = (event: MessageEvent<
  | { name: string; identity: string; journalName?: string }
  | { file: FileSystemFileHandle; length: number; imageIdentitySha256: string; integrityPolicy: PersistentImageIntegrityPolicy }
>) => {
  void (async () => {
    try {
      if ("file" in event.data) {
        const geometry = await inspectPersistentImageFile(event.data.file, await loadPositionedImageWriterModuleBytes(),
          event.data.length, event.data.imageIdentitySha256, event.data.integrityPolicy);
        const reader = await OpfsImageReader.open(event.data.file, undefined, undefined, true);
        try {
          const first = new Uint8Array(3);
          const last = new Uint8Array(3);
          const firstRead = reader.readAt(128, first);
          const lastRead = reader.readAt(128 + geometry.payloadLength - 3, last);
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
        { chunks: [first, Uint8Array.of(1, 2, 3)], payloadLength: first.length + 3, integrityPolicy: "crc32c" },
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
        undefined,
        undefined,
        event.data.journalName,
      );
      self.postMessage({ type: "done", file: saved.file, length: saved.length });
    } catch (error) {
      self.postMessage({ type: "error", message: String(error) });
    }
  })();
};
