import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { resolveBinary } from "../../src/binary-resolver";

export const EXEC_MEMORY_REFUSAL_LIMITS = {
  maxPages: 4096,
  kernelMaxPages: 12288,
  maxProcessMemoryBytes: 48 * 1024 * 1024,
} as const;

export async function createExecMemoryRefusalImage(): Promise<Uint8Array> {
  const modulePath = resolve(import.meta.dirname, "../../../local-binaries/kandelo_image_module32.wasm");
  const owner = KandeloImageFs.create(new Uint8Array(readFileSync(modulePath)));
  try {
    owner.mkdir("/bin", 0o755);
    for (const [path, name] of [
      ["/bin/parent", "exec-memory-refusal"],
      ["/bin/small", "exec-memory-refusal-small"],
      ["/bin/large", "exec-memory-refusal-large"],
    ]) {
      owner.createFileWithOwner(path, 0o755, 0, 0,
        new Uint8Array(readFileSync(resolveBinary(`test-fixtures/wasm32/${name}.wasm`))));
    }
    return await owner.saveImage();
  } finally {
    owner.reset();
  }
}
