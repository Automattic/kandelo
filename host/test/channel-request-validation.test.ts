import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HostDiagnostic } from "../src/host-diagnostic";
import { NodeKernelHost } from "../src/node-kernel-host";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const program = join(repoRoot, "examples/channel_request_validation_test.wasm");

const BAD_REQUEST_CASES = [
  "unknown-flag",
  "record-flag-without-record",
  "record-syscall-mismatch",
  "record-bad-abi",
  "record-bad-length",
  "raw-syscall-with-record-flag",
];

// A process writes its own syscall channel, so the request header and the
// opaque argument record are untrusted input. A malformed or contradictory
// request must fail that one syscall with an errno; it must never stop the
// shared kernel worker, which would take every other process down with it.
//
// The guest runs each bad request in a forked child; the parent is the
// "other process". The harness drives NodeKernelHost directly so that a
// kernel-wide failure reports the guest output and host diagnostics it
// produced before the kernel stopped, instead of only a timeout.
describe("syscall channel request validation", () => {
  it("answers each bad request with EINVAL and keeps serving other processes", async () => {
    // Fail rather than skip: a missing fixture would otherwise make this
    // contract silently stop being checked.
    expect(
      existsSync(program),
      `${program} is missing; build it with scripts/build-programs.sh`,
    ).toBe(true);

    let stdout = "";
    let stderr = "";
    const diagnostics: HostDiagnostic[] = [];
    const host = new NodeKernelHost({
      maxWorkers: 4,
      onStdout: (_pid, data) => {
        stdout += new TextDecoder().decode(data);
      },
      onStderr: (_pid, data) => {
        stderr += new TextDecoder().decode(data);
      },
      onHostDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    });
    const report = () =>
      `stdout:\n${stdout}\nstderr:\n${stderr}\nhost diagnostics:\n`
      + diagnostics.map((d) => `  [${d.source}] ${d.message}`).join("\n");

    let exitCode: number | string;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await host.init();
      const exit = host.spawn(
        new Uint8Array(readFileSync(program)).buffer,
        ["channel_request_validation_test"],
        { stdin: new Uint8Array() },
      );
      exitCode = await Promise.race([
        exit.catch((error: unknown) => `rejected: ${String(error)}`),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("timed out"), 30_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      await host.destroy().catch(() => {});
    }

    expect(exitCode, report()).toBe(0);
    for (const name of BAD_REQUEST_CASES) {
      expect(stdout, report()).toContain(`${name}: ret=-1 errno=22\n`);
    }
    expect(stdout, report()).toContain(
      "payload-looks-like-record: write=64 errno=0 read=64\n",
    );
    expect(stdout, report()).toContain(
      "PASS channel requests fail per process",
    );
  }, 60_000);
});
