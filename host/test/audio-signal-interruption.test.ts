import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodePcmDriver } from "../src/audio/node-pcm-driver";
import { NodePlatformIO } from "../src/platform/node";
import type { CentralizedKernelWorker } from "../src/kernel-worker";
import { runCentralizedProgram } from "./centralized-test-helper";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const program = join(repoRoot, "examples/dsp_signal_test.wasm");

describe.skipIf(!existsSync(program))("/dev/dsp signal interruption", () => {
  it("delivers caught signals, applies narrow SA_RESTART, and preserves an interrupted close fd", async () => {
    let kernel: CentralizedKernelWorker | null = null;
    let driver: NodePcmDriver | null = null;
    let consumedBytes = 0;
    try {
      const result = await runCentralizedProgram({
        programPath: program,
        argv: ["dsp_signal_test"],
        useDefaultRootfs: false,
        timeout: 15_000,
        io: new NodePlatformIO(),
        onKernelReady: async (readyKernel) => {
          kernel = readyKernel;
          driver = new NodePcmDriver({
            clockUpdate: (frames) => readyKernel.pcmClockUpdate(frames),
            onConsume: ({ bytes }) => {
              consumedBytes += bytes.byteLength;
            },
          });
          await driver.prepare(readyKernel.claimPcmTransport(false));
        },
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("PASS dsp signal interruption alarms=6");
      expect(consumedBytes).toBeGreaterThan(0);
      expect(kernel).not.toBeNull();
      expect(await kernel!.waitForPcmDrain(1000)).toBe(true);
    } finally {
      await driver?.close().catch(() => {});
      kernel?.shutdownPcmTransport();
    }
  }, 20_000);
});
