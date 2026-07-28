import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CH_DATA_SIZE,
  CH_TOTAL_SIZE,
  KERNEL_IOVEC_WIRE_ALIGN,
  POSIX_IOV_MAX,
  STRUCT_SIZE_KERNEL_IOVEC_WIRE,
} from "../src/generated/abi";
import { runCentralizedProgram } from "./centralized-test-helper";
import { ensureWasm64ExampleFixture } from "./wasm64-example-fixture";
import { NodeKernelHost } from "../src/node-kernel-host";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const programs = [
  [
    "wasm32",
    join(repoRoot, "examples/kernel_scratch_browser_test.wasm"),
  ],
  [
    "wasm64",
    join(repoRoot, "examples/kernel_scratch_browser_test.wasm64.wasm"),
  ],
] as const;
const boundaryReadvDataBytes =
  CH_DATA_SIZE - POSIX_IOV_MAX * STRUCT_SIZE_KERNEL_IOVEC_WIRE;
const boundaryReadvBytesPerIovec =
  boundaryReadvDataBytes / POSIX_IOV_MAX;
const largeIovecCount = 2;
const largeBytesPerIovec = Math.floor(CH_DATA_SIZE / 2) + 1;
const largeBytes = largeIovecCount * largeBytesPerIovec;
const ptyByte = 0x51;
const ptyLength = CH_TOTAL_SIZE + 1;

if (
  !Number.isInteger(boundaryReadvBytesPerIovec) ||
  boundaryReadvBytesPerIovec <= 0 ||
  boundaryReadvBytesPerIovec % KERNEL_IOVEC_WIRE_ALIGN !== 0
) {
  throw new Error("generated readv scratch layout cannot form an exact boundary");
}
if (largeBytes <= CH_DATA_SIZE) {
  throw new Error("large vector fixture must exceed ordinary channel scratch");
}

async function runPtyFixture(programPath: string): Promise<{
  exitCode: number;
  output: string;
  stderr: string;
  hostDiagnostics: unknown[];
}> {
  const bytes = readFileSync(programPath);
  const program = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const decoder = new TextDecoder();
  const hostDiagnostics: unknown[] = [];
  let output = "";
  let stderr = "";
  let sentInput = false;
  let host: NodeKernelHost;
  host = new NodeKernelHost({
    maxWorkers: 4,
    onPtyOutput: (pid, data) => {
      output += decoder.decode(data);
      if (!sentInput && output.includes("KERNEL_SCRATCH_PTY_READY")) {
        sentInput = true;
        host.ptyWrite(pid, new Uint8Array(ptyLength).fill(ptyByte));
      }
    },
    onStderr: (_pid, data) => {
      stderr += decoder.decode(data);
    },
    onHostDiagnostic: (diagnostic) => {
      hostDiagnostics.push(diagnostic);
    },
  });

  await host.init();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([
      host.spawn(
        program,
        [
          "kernel-scratch-browser-test",
          "pty",
          String(ptyLength),
          String(ptyByte),
        ],
        { pty: true },
      ),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Node PTY fixture timed out after 30 seconds")),
          30_000,
        );
      }),
    ]);
    return { exitCode, output, stderr, hostDiagnostics };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await host.destroy().catch(() => {});
  }
}

describe("owned kernel scratch in the real Node runtime", () => {
  it.each(programs)(
    "preserves vector and PTY operation boundaries for a %s guest",
    async (arch, program) => {
      const programPath = arch === "wasm64"
        ? ensureWasm64ExampleFixture("kernel_scratch_browser_test.c")
        : program;
      const cases = [
        {
          argv: [
            "kernel-scratch-browser-test",
            "readv",
            String(POSIX_IOV_MAX),
            String(boundaryReadvBytesPerIovec),
          ],
          marker:
            `KERNEL_SCRATCH_READV_PASS iovecs=${POSIX_IOV_MAX} bytes=${boundaryReadvDataBytes}`,
          useDefaultRootfs: false,
        },
        {
          argv: [
            "kernel-scratch-browser-test",
            "dgram-vector",
            String(largeIovecCount),
            String(largeBytesPerIovec),
          ],
          marker:
            `KERNEL_SCRATCH_DGRAM_VECTOR_PASS iovecs=${largeIovecCount} bytes=${largeBytes} datagrams=1`,
          useDefaultRootfs: false,
        },
        {
          argv: [
            "kernel-scratch-browser-test",
            "positioned-vector",
            String(largeIovecCount),
            String(largeBytesPerIovec),
          ],
          marker:
            `KERNEL_SCRATCH_POSITIONED_VECTOR_PASS iovecs=${largeIovecCount} bytes=${largeBytes} offset=4096 cursor=37`,
          useDefaultRootfs: false,
        },
        {
          argv: ["kernel-scratch-browser-test", "append-flags"],
          marker: "KERNEL_SCRATCH_APPEND_FLAGS_PASS bytes=5",
          // Exact native append outcomes require the uniquely owned session
          // scratch mount; raw NodePlatformIO is externally mutable.
          useDefaultRootfs: true,
        },
        {
          argv: ["kernel-scratch-browser-test", "zero-iov"],
          marker:
            `KERNEL_SCRATCH_ZERO_IOV_PASS pointer_bits=${arch === "wasm64" ? 64 : 32}`,
          useDefaultRootfs: false,
        },
      ];

      for (const fixture of cases) {
        const result = await runCentralizedProgram({
          programPath,
          argv: fixture.argv,
          timeout: 30_000,
          useDefaultRootfs: fixture.useDefaultRootfs,
        });

        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout).toContain(fixture.marker);
        expect(result.stderr).toBe("");
        expect(result.hostDiagnostics).toEqual([]);
      }

      const pty = await runPtyFixture(programPath);
      expect(pty.exitCode, pty.stderr).toBe(0);
      expect(pty.output).toContain("KERNEL_SCRATCH_PTY_READY");
      expect(pty.output).toContain(
        `KERNEL_SCRATCH_PTY_PASS bytes=${ptyLength}`,
      );
      expect(pty.stderr).toBe("");
      expect(pty.hostDiagnostics).toEqual([]);
    },
    120_000,
  );
});
