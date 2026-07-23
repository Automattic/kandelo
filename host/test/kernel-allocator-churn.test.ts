import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";

const __dirname = dirname(fileURLToPath(import.meta.url));
const churnProgram = resolve(
  __dirname,
  "../../examples/kernel_allocator_churn_test.wasm",
);

function readArrayBuffer(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function runChurn(
  mode: "pipe" | "fork",
  count: number,
): Promise<{ pages: number; stdout: string }> {
  let stdout = "";
  let stderr = "";
  const diagnostics: string[] = [];
  const host = new NodeKernelHost({
    onStdout: (_pid, bytes) => {
      stdout += new TextDecoder().decode(bytes);
    },
    onStderr: (_pid, bytes) => {
      stderr += new TextDecoder().decode(bytes);
    },
    onHostDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic.message);
    },
  });

  await host.init(readArrayBuffer(resolveBinary("kernel.wasm")));
  try {
    const exitCode = await host.spawn(
      readArrayBuffer(churnProgram),
      ["kernel_allocator_churn_test", mode, String(count)],
    );
    expect(exitCode, `${mode} churn stderr: ${stderr}`).toBe(0);
    expect(stderr).toBe("");
    expect(diagnostics).toEqual([]);
    expect(stdout).toContain(
      `KERNEL_ALLOCATOR_${mode.toUpperCase()}_PASS count=${count}`,
    );
    return {
      pages: await host.getKernelMemoryPages(),
      stdout,
    };
  } finally {
    await host.destroy();
  }
}

describe("kernel allocator lifetime under process and descriptor churn", () => {
  it(
    "reuses closed pipe storage instead of growing with total pipe history",
    async () => {
      const warm = await runChurn("pipe", 1_000);
      const stressed = await runChurn("pipe", 20_000);

      // WebAssembly memory cannot shrink, but freed allocator chunks must be
      // reused. Twenty times more sequential pipes should therefore remain
      // within a small metadata tolerance of the warmed-up kernel.
      expect(stressed.pages).toBeLessThanOrEqual(warm.pages + 16);
    },
    120_000,
  );

  it(
    "reuses fork serialization and reaped-child state",
    async () => {
      const warm = await runChurn("fork", 8);
      const stressed = await runChurn("fork", 128);

      // Every child is synchronously waitpid-reaped before the next fork.
      // The allocator may retain a few larger bins, but memory must not grow
      // in proportion to the number of historical children.
      expect(stressed.pages).toBeLessThanOrEqual(warm.pages + 64);
    },
    120_000,
  );
});
