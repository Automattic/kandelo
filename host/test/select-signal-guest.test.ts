import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { ensureWasm64ExampleFixture } from "./wasm64-example-fixture";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const programs = [
  ["wasm32", join(repoRoot, "examples/select_signal_test.wasm")],
  ["wasm64", join(repoRoot, "examples/select_signal_test.wasm64.wasm")],
] as const;
const pendingMarker = "TASK16_GATE=";
const restartMarker = "TASK16_RESTART_GATE=";
const timeoutMarker = "TASK16_TIMEOUT_GATE=";
const blockedMarker = "TASK16_BLOCK\n";
const sigalrm = 14;
const sigterm = 15;

describe.skipIf(!existsSync(programs[0][1]))("select signal guest", () => {
  it.each(programs)(
    "runs the real ppoll/pselect interruption and signal-mask matrix for %s",
    async (arch, program) => {
      const programPath =
        arch === "wasm64"
          ? ensureWasm64ExampleFixture("select_signal_test.c")
          : program;
      let stdout = "";
      let stderr = "";
      let markerBuffer = "";
      let injectedSignals = 0;
      let blockedSignals = 0;
      let restartSignals = 0;
      let timeoutGates = 0;
      let injectionFailure: Error | undefined;
      const stdoutDecoder = new TextDecoder();
      const stderrDecoder = new TextDecoder();

      const result = await runCentralizedProgram({
        programPath,
        argv: ["select_signal_test"],
        useDefaultRootfs: false,
        timeout: 20_000,
        onKernelReady: (kernelWorker, pid) => {
          kernelWorker.setOutputCallbacks({
            onStdout: (data) => {
              const text = stdoutDecoder.decode(data, { stream: true });
              stdout += text;
              markerBuffer += text;
              for (;;) {
                const pendingAt = markerBuffer.indexOf(pendingMarker);
                const restartAt = markerBuffer.indexOf(restartMarker);
                const timeoutAt = markerBuffer.indexOf(timeoutMarker);
                const blockedAt = markerBuffer.indexOf(blockedMarker);
                const candidates = [
                  [pendingAt, "pending"] as const,
                  [restartAt, "restart"] as const,
                  [timeoutAt, "timeout"] as const,
                  [blockedAt, "blocked"] as const,
                ]
                  .filter(([at]) => at >= 0)
                  .sort(([left], [right]) => left - right);
                const next = candidates[0];
                if (!next) break;
                const [nextAt, kind] = next;
                if (kind === "blocked") {
                  markerBuffer = markerBuffer.slice(
                    nextAt + blockedMarker.length,
                  );
                  setTimeout(() => {
                    try {
                      if (!kernelWorker.signalProcess(pid, sigalrm)) {
                        throw new Error("host rejected blocked-case SIGALRM");
                      }
                      blockedSignals++;
                    } catch (error) {
                      injectionFailure =
                        error instanceof Error
                          ? error
                          : new Error(String(error));
                    }
                  }, 50);
                  continue;
                }
                const gateMarker = kind === "restart"
                  ? restartMarker
                  : kind === "timeout"
                    ? timeoutMarker
                    : pendingMarker;
                const lineEnd = markerBuffer.indexOf("\n", nextAt);
                if (lineEnd === -1) break;
                const rawAddress = markerBuffer.slice(
                  nextAt + gateMarker.length,
                  lineEnd,
                );
                markerBuffer = markerBuffer.slice(lineEnd + 1);
                const releaseGate = () => {
                  try {
                    const address = Number.parseInt(rawAddress, 10);
                    const memory = kernelWorker.getProcessMemory(pid);
                    if (
                      !Number.isSafeInteger(address) ||
                      address < 0 ||
                      address % Int32Array.BYTES_PER_ELEMENT !== 0 ||
                      memory === undefined ||
                      address + Int32Array.BYTES_PER_ELEMENT >
                        memory.buffer.byteLength
                    ) {
                      throw new Error(
                        `invalid guest ${kind} gate ${rawAddress}`,
                      );
                    }
                    const signal = kind === "restart" ? sigterm : sigalrm;
                    if (
                      kind !== "timeout" &&
                      !kernelWorker.signalProcess(pid, signal)
                    ) {
                      throw new Error(
                        `host rejected ${kind} signal ${signal}`,
                      );
                    }
                    Atomics.store(
                      new Int32Array(memory.buffer),
                      address / Int32Array.BYTES_PER_ELEMENT,
                      1,
                    );
                    if (kind === "restart") restartSignals++;
                    else if (kind === "timeout") timeoutGates++;
                    else injectedSignals++;
                  } catch (error) {
                    injectionFailure =
                      error instanceof Error ? error : new Error(String(error));
                  }
                };
                    if (kind === "restart" || kind === "timeout") {
                      setTimeout(releaseGate, 250);
                    }
                    else queueMicrotask(releaseGate);
              }
            },
            onStderr: (data) => {
              stderr += stderrDecoder.decode(data, { stream: true });
            },
          });
        },
      });

      stdout += stdoutDecoder.decode();
      stderr += stderrDecoder.decode();
      expect(result.exitCode, stderr).toBe(0);
      expect(injectionFailure).toBeUndefined();
      expect(injectedSignals).toBe(8);
      expect(blockedSignals).toBe(14);
      expect(restartSignals).toBe(1);
      expect(timeoutGates).toBe(2);
      expect(stdout).toContain(
        "PASS ppoll/pselect signal mask interruption matrix",
      );
      expect(stderr).toBe("");
    },
    30_000,
  );
});
