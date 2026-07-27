import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CH_DATA_SIZE,
  CH_TOTAL_SIZE,
  KERNEL_IOVEC_WIRE_ALIGN,
  POSIX_IOV_MAX,
  STRUCT_SIZE_KERNEL_IOVEC_WIRE,
} from "../../../host/src/generated/abi";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programs = [
  {
    arch: "wasm32",
    path: resolve(
      __dirname,
      "../../../examples/kernel_scratch_browser_test.wasm",
    ),
  },
  {
    arch: "wasm64",
    path: resolve(
      __dirname,
      "../../../examples/kernel_scratch_browser_test.wasm64.wasm",
    ),
  },
] as const;
const ptyByte = 0x51;
const ptyLength = CH_TOTAL_SIZE + 1;
const readvDataBytes =
  CH_DATA_SIZE - POSIX_IOV_MAX * STRUCT_SIZE_KERNEL_IOVEC_WIRE;
const readvBytesPerIovec = readvDataBytes / POSIX_IOV_MAX;
const largeVectorIovecCount = 2;
const largeVectorBytesPerIovec = Math.floor(CH_DATA_SIZE / 2) + 1;
const largeVectorBytes =
  largeVectorIovecCount * largeVectorBytesPerIovec;

if (
  !Number.isInteger(readvBytesPerIovec) ||
  readvBytesPerIovec <= 0 ||
  readvBytesPerIovec % KERNEL_IOVEC_WIRE_ALIGN !== 0
) {
  throw new Error("generated readv scratch layout cannot form an exact boundary");
}
if (largeVectorBytes <= CH_DATA_SIZE) {
  throw new Error("large vector fixture must exceed ordinary channel scratch");
}

for (const program of programs) {
  test(`owned kernel scratch preserves ${program.arch} vector operations and chunked PTY input in Chromium`, async ({
    page,
    baseURL,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "the aggregate browser gate uses Chromium",
    );
    expect(baseURL).toBeTruthy();

    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => {
      runtimeErrors.push(`pageerror: ${error.message}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        runtimeErrors.push(`console: ${message.text()}`);
      }
    });
    page.on("requestfailed", (request) => {
      runtimeErrors.push(
        `requestfailed: ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
      );
    });

    await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
    await page.waitForFunction(() => (window as any).__testRunnerReady === true);

    const programUrl = new URL(`/@fs/${program.path}`, baseURL).href;
    const results = await page.evaluate(
      async ({
        programUrl,
        iovecCount,
        bytesPerIovec,
        largeIovecCount,
        largeBytesPerIovec,
        ptyInputLength,
        ptyInputByte,
      }) => {
        const response = await fetch(programUrl);
        if (!response.ok) {
          throw new Error(
            `program fetch failed: ${response.status} ${response.url}`,
          );
        }
        const programBytes = await response.arrayBuffer();
        const readv = await (window as any).__runTest(
          programBytes.slice(0),
          [
            "kernel-scratch-browser-test",
            "readv",
            String(iovecCount),
            String(bytesPerIovec),
          ],
          30_000,
        );
        const datagramVector = await (window as any).__runTest(
          programBytes.slice(0),
          [
            "kernel-scratch-browser-test",
            "dgram-vector",
            String(largeIovecCount),
            String(largeBytesPerIovec),
          ],
          30_000,
        );
        const positionedVector = await (window as any).__runTest(
          programBytes.slice(0),
          [
            "kernel-scratch-browser-test",
            "positioned-vector",
            String(largeIovecCount),
            String(largeBytesPerIovec),
          ],
          30_000,
        );
        const appendFlags = await (window as any).__runTest(
          programBytes.slice(0),
          ["kernel-scratch-browser-test", "append-flags"],
          30_000,
        );
        const zeroIov = await (window as any).__runTest(
          programBytes.slice(0),
          ["kernel-scratch-browser-test", "zero-iov"],
          30_000,
        );
        const pty = await (window as any).__runTest(
          programBytes.slice(0),
          [
            "kernel-scratch-browser-test",
            "pty",
            String(ptyInputLength),
            String(ptyInputByte),
          ],
          30_000,
          {
            ptyInput: {
              data: new Uint8Array(ptyInputLength).fill(ptyInputByte),
              readyMarker: "KERNEL_SCRATCH_PTY_READY",
            },
          },
        );
        return {
          readv,
          datagramVector,
          positionedVector,
          appendFlags,
          zeroIov,
          pty,
        };
      },
      {
        programUrl,
        iovecCount: POSIX_IOV_MAX,
        bytesPerIovec: readvBytesPerIovec,
        largeIovecCount: largeVectorIovecCount,
        largeBytesPerIovec: largeVectorBytesPerIovec,
        ptyInputLength: ptyLength,
        ptyInputByte: ptyByte,
      },
    );

    expect(results.readv.exitCode, results.readv.stderr).toBe(0);
    expect(results.readv.stdout).toContain(
      `KERNEL_SCRATCH_READV_PASS iovecs=${POSIX_IOV_MAX} bytes=${readvDataBytes}`,
    );
    expect(results.readv.stderr).toBe("");
    expect(results.readv.hostDiagnostics).toEqual([]);

    expect(
      results.datagramVector.exitCode,
      results.datagramVector.stderr,
    ).toBe(0);
    expect(results.datagramVector.stdout).toContain(
      `KERNEL_SCRATCH_DGRAM_VECTOR_PASS iovecs=${largeVectorIovecCount} bytes=${largeVectorBytes} datagrams=1`,
    );
    expect(results.datagramVector.stderr).toBe("");
    expect(results.datagramVector.hostDiagnostics).toEqual([]);

    expect(
      results.positionedVector.exitCode,
      results.positionedVector.stderr,
    ).toBe(0);
    expect(results.positionedVector.stdout).toContain(
      `KERNEL_SCRATCH_POSITIONED_VECTOR_PASS iovecs=${largeVectorIovecCount} bytes=${largeVectorBytes} offset=4096 cursor=37`,
    );
    expect(results.positionedVector.stderr).toBe("");
    expect(results.positionedVector.hostDiagnostics).toEqual([]);

    expect(results.appendFlags.exitCode, results.appendFlags.stderr).toBe(0);
    expect(results.appendFlags.stdout).toContain(
      "KERNEL_SCRATCH_APPEND_FLAGS_PASS bytes=5",
    );
    expect(results.appendFlags.stderr).toBe("");
    expect(results.appendFlags.hostDiagnostics).toEqual([]);

    expect(results.zeroIov.exitCode, results.zeroIov.stderr).toBe(0);
    expect(results.zeroIov.stdout).toContain(
      `KERNEL_SCRATCH_ZERO_IOV_PASS pointer_bits=${program.arch === "wasm64" ? 64 : 32}`,
    );
    expect(results.zeroIov.stderr).toBe("");
    expect(results.zeroIov.hostDiagnostics).toEqual([]);

    expect(results.pty.exitCode, results.pty.stderr).toBe(0);
    expect(results.pty.stdout).toContain("KERNEL_SCRATCH_PTY_READY");
    expect(results.pty.stdout).toContain(
      `KERNEL_SCRATCH_PTY_PASS bytes=${ptyLength}`,
    );
    expect(results.pty.stderr).toBe("");
    expect(results.pty.hostDiagnostics).toEqual([]);
    expect(runtimeErrors).toEqual([]);
  });
}
