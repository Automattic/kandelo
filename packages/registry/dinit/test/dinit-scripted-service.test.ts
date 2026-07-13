import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ABI_VERSION } from "../../../../host/src/generated/abi";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import type { HostDiagnostic } from "../../../../host/src/host-diagnostic";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "../../../../host/src/vfs/image-helpers";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { addDinitInit } from "../../../../images/vfs/scripts/dinit-image-helpers";

const dinitBinary = tryResolveBinary("programs/dinit/dinit.wasm");
const dinitctlBinary = tryResolveBinary("programs/dinit/dinitctl.wasm");
const coreutilsBinary = tryResolveBinary("programs/coreutils.wasm");
const hasArtifacts = !!dinitBinary && !!dinitctlBinary && !!coreutilsBinary;

async function createScriptedServiceImage(
  createdBy: string,
  malformedRestart = false,
): Promise<Uint8Array> {
  const maxBytes = 32 * 1024 * 1024;
  const sab = new SharedArrayBuffer(maxBytes, { maxByteLength: maxBytes });
  const fs = MemoryFileSystem.create(sab, maxBytes);
  for (const dir of ["/bin", "/var", "/home", "/root", "/srv"]) {
    ensureDirRecursive(fs, dir);
  }
  writeVfsBinary(
    fs,
    "/bin/true",
    new Uint8Array(readFileSync(coreutilsBinary!)),
  );
  addDinitInit(fs, [{
    name: "one-shot",
    type: "scripted",
    command: "/bin/true",
    restart: false,
  }]);
  if (malformedRestart) {
    writeVfsFile(
      fs,
      "/etc/dinit.d/one-shot",
      "type = scripted\ncommand = /bin/true\nrestart = banana\n",
    );
  }
  return fs.saveImage({
    metadata: {
      version: 1,
      kernelAbi: ABI_VERSION,
      createdBy,
    },
  });
}

describe.skipIf(!hasArtifacts)("dinit supervisor", () => {
  it(
    "completes a scripted service without aborting",
    { timeout: 30_000 },
    async () => {
      const dinitBytes = readFileSync(dinitBinary!);
      expect(dinitBytes.includes(Buffer.from("wpk_fork_state"))).toBe(true);

      const image = await createScriptedServiceImage(
        "dinit scripted-service integration test",
      );

      let stdout = "";
      let stderr = "";
      const diagnostics: HostDiagnostic[] = [];
      const events: Array<{
        kind: "spawn" | "exec" | "exit";
        pid: number;
        ppid?: number;
        exitStatus?: number;
      }> = [];
      const stdoutDecoder = new TextDecoder();
      const stderrDecoder = new TextDecoder();
      const host = new NodeKernelHost({
        rootfsImage: image,
        onStdout: (_pid, data) => {
          stdout += stdoutDecoder.decode(data, { stream: true });
        },
        onStderr: (_pid, data) => {
          stderr += stderrDecoder.decode(data, { stream: true });
        },
        onHostDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        onProcessEvent: (event) => events.push(event),
      });

      await host.init();
      let dinitPid = -1;
      let dinitExit: Promise<number> | undefined;
      try {
        const program = dinitBytes.buffer.slice(
          dinitBytes.byteOffset,
          dinitBytes.byteOffset + dinitBytes.byteLength,
        ) as ArrayBuffer;
        dinitExit = host.spawn(
          program,
          ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl", "boot"],
          {
            cwd: "/",
            stdin: new Uint8Array(),
            onStarted: (pid) => {
              dinitPid = pid;
            },
          },
        );

        await expect.poll(
          () => stdout,
          { timeout: 10_000, interval: 50 },
        ).toContain("[  OK  ] one-shot");

        // A successful scripted service means dinit forked and exec'd the
        // helper, reaped its zero exit status, and stayed alive as PID 1.
        // Leaving dasynq's pselect pull_events() noexcept makes the Wasm SjLj
        // transfer reach std::terminate while handling SIGCHLD instead.
        expect(events).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "spawn", ppid: dinitPid }),
          expect.objectContaining({ kind: "exec" }),
          expect.objectContaining({ kind: "exit", exitStatus: 0 }),
        ]));
        expect((await host.enumProcs()).some(({ pid }) => pid === dinitPid))
          .toBe(true);
        expect(stderr).not.toContain("libc++abi: terminating");
        expect(diagnostics).toEqual([]);
      } finally {
        await host.destroy().catch(() => {});
        void dinitExit?.catch(() => {});
      }
    },
  );

  it(
    "reports malformed service settings through dinit's C++ catch path",
    { timeout: 20_000 },
    async () => {
      const image = await createScriptedServiceImage(
        "dinit malformed-service integration test",
        true,
      );
      const result = await runCentralizedProgram({
        programPath: dinitBinary!,
        argv: ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl", "boot"],
        rootfsImage: image,
        timeout: 10_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Error in service description for 'one-shot'");
      expect(result.stdout).toContain("restart must be one of");
      expect(result.stderr).toBe("");
      expect(result.hostDiagnostics).toEqual([]);
    },
  );
});
