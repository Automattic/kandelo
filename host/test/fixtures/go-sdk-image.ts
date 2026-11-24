import { readFileSync } from "node:fs";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { readWasmCustomSectionPayload } from "../../src/constants";

export const goSdkProbePath = "/bin/go-sdk-probe";
export const goSdkProbeParallelism = [1, 2, 4, "auto"] as const;
export const goSdkProbeOutput = [
  "Go goroutines and GC OK",
  "Go file I/O OK",
  "Go loopback TCP OK",
  "Go subprocess OK",
  "Go shutdown OK",
  "Go loop preemption OK",
].join("\n") + "\n";

export async function createGoSdkImage(wasmPath: string) {
  const wasm = new Uint8Array(readFileSync(wasmPath));
  const expectedDigest = readFileSync(
    new URL("../../../libc/glue/kandelo-abi-contract.txt", import.meta.url), "utf8",
  ).trim();
  const digest = readWasmCustomSectionPayload(wasm.buffer, "kandelo.abi.contract");
  if (digest === null || Buffer.from(digest).toString("hex") !== expectedDigest) {
    throw new Error("The Go SDK probe must be built with this checkout's ABI contract");
  }
  const fs = KandeloImageFs.create();
  try {
    fs.mkdir("/bin", 0o755);
    fs.mkdir("/tmp", 0o1777);
    fs.createFileWithOwner(goSdkProbePath, 0o755, 0, 0, wasm);
    return await fs.saveImage();
  } finally {
    fs.reset();
  }
}
