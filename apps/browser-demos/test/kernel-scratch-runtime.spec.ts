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
const programPath = resolve(
  __dirname,
  "../../../examples/kernel_scratch_browser_test.wasm",
);
const ptyByte = 0x51;
const ptyLength = CH_TOTAL_SIZE + 1;
const readvDataBytes =
  CH_DATA_SIZE - POSIX_IOV_MAX * STRUCT_SIZE_KERNEL_IOVEC_WIRE;
const readvBytesPerIovec = readvDataBytes / POSIX_IOV_MAX;

if (
  !Number.isInteger(readvBytesPerIovec) ||
  readvBytesPerIovec <= 0 ||
  readvBytesPerIovec % KERNEL_IOVEC_WIRE_ALIGN !== 0
) {
  throw new Error("generated readv scratch layout cannot form an exact boundary");
}

test("owned kernel scratch carries exact-boundary readv and chunked PTY input in Chromium", async ({
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

  const programUrl = new URL(`/@fs/${programPath}`, baseURL).href;
  const results = await page.evaluate(
    async ({
      programUrl,
      iovecCount,
      bytesPerIovec,
      ptyInputLength,
      ptyInputByte,
    }) => {
      const response = await fetch(programUrl);
      if (!response.ok) {
        throw new Error(
          `program fetch failed: ${response.status} ${response.url}`,
        );
      }
      const program = await response.arrayBuffer();
      const readv = await (window as any).__runTest(
        program.slice(0),
        [
          "kernel-scratch-browser-test",
          "readv",
          String(iovecCount),
          String(bytesPerIovec),
        ],
        30_000,
      );
      const pty = await (window as any).__runTest(
        program.slice(0),
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
      return { readv, pty };
    },
    {
      programUrl,
      iovecCount: POSIX_IOV_MAX,
      bytesPerIovec: readvBytesPerIovec,
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

  expect(results.pty.exitCode, results.pty.stderr).toBe(0);
  expect(results.pty.stdout).toContain("KERNEL_SCRATCH_PTY_READY");
  expect(results.pty.stdout).toContain(
    `KERNEL_SCRATCH_PTY_PASS bytes=${ptyLength}`,
  );
  expect(results.pty.stderr).toBe("");
  expect(results.pty.hostDiagnostics).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});
