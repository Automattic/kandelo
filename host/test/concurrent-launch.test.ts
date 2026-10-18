import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";

const __dirname = dirname(fileURLToPath(import.meta.url));
const helloWasm = join(__dirname, "../../examples/hello.wasm");

function loadProgramBytes(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// A launch queries the kernel while another launch's work (its host stdin
// pipe install) can still be queued at the kernel entry gate. The query must
// wait its turn, not fail the launch.
describe("concurrent launches", () => {
  it("runs eight programs launched at once", { timeout: 60_000 }, async () => {
    const hello = loadProgramBytes(helloWasm);
    const host = new NodeKernelHost();
    await host.init();
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => host.spawn(hello, ["hello"], {})),
      );
      expect(results.map((r) => (r.status === "fulfilled" ? r.value : String(r.reason))))
        .toEqual(Array(8).fill(0));
    } finally {
      await host.destroy();
    }
  });
});
