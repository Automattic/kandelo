import { readFileSync } from "node:fs";
import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs";
import { resolveBinary } from "../../../../host/src/binary-resolver";

export const transferBytes = Uint8Array.from({ length: 32775 }, (_, i) => i % 256);
export async function termchatImage(): Promise<Uint8Array> {
  const image = KandeloImageFs.create();
  for (const path of ["/etc", "/root", "/tmp", "/usr", "/usr/bin", "/usr/share"]) image.mkdir(path, 0o755);
  const text = new TextEncoder();
  image.writeFile("/etc/passwd", text.encode("root:x:0:0:Root:/root:/bin/sh\n"), 0o644);
  image.writeFile("/etc/group", text.encode("root:x:0:\n"), 0o644);
  image.writeFile("/etc/hosts", text.encode("127.0.0.1 localhost\n"), 0o644);
  image.writeFile("/usr/bin/termchat", new Uint8Array(readFileSync(resolveBinary("programs/termchat.wasm"))), 0o755);
  image.writeFile("/usr/share/probe.bin", transferBytes, 0o644);
  return image.saveImage();
}

export function terminalText(raw: string): string {
  return raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[()][A-Z0-9]/g, "");
}
