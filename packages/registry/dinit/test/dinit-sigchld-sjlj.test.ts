import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findRepoRoot,
  resolveBinary,
  tryResolveBinary,
} from "../../../../host/src/binary-resolver";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { writeVfsBinary } from "../../../../host/src/vfs/image-helpers";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { addDinitInit } from "../../../../images/vfs/scripts/dinit-image-helpers";

const fixture = resolveBinary("programs/dinit_sigchld_sjlj.wasm");
const noexceptFixture = resolveBinary(
  "programs/dinit_sjlj_noexcept_boundary.wasm",
);
const rawNoexceptFixture = join(
  findRepoRoot(),
  "local-binaries/test-fixtures/dinit_sjlj_noexcept_boundary_uninstrumented.wasm",
);
const dinit = tryResolveBinary("programs/dinit/dinit.wasm");
const TERMINATED_BY_SIGABRT = 128 + 6;
const TERMINATED_BY_SIGTERM = 128 + 15;

function arrayBuffer(bytes: Buffer | Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

describe("dinit Wasm exception and SjLj compatibility", () => {
  it("keeps the negative control structurally independent of fork instrumentation", () => {
    const rawModule = new WebAssembly.Module(readFileSync(rawNoexceptFixture));
    const instrumentedModule = new WebAssembly.Module(
      readFileSync(noexceptFixture),
    );
    const exportNames = (module: WebAssembly.Module) =>
      WebAssembly.Module.exports(module).map(({ name }) => name);

    expect(exportNames(rawModule)).not.toContain("wpk_fork_state");
    expect(exportNames(instrumentedModule)).toContain("wpk_fork_state");
  });

  it.each([
    ["clang-linked", rawNoexceptFixture],
    ["fork-instrumented", noexceptFixture],
  ])(
    "terminates at the %s noexcept boundary before landing",
    async (_, programPath) => {
      const result = await runCentralizedProgram({
        programPath,
        argv: ["dinit_sjlj_noexcept_boundary", "--noexcept"],
        timeout: 10_000,
        useDefaultRootfs: false,
      });

      expect(result.exitCode).toBe(TERMINATED_BY_SIGABRT);
      expect(result.stderr).toContain("HANDLER: siglongjmp");
      expect(result.stderr).toContain("libc++abi: terminating");
      expect(result.stdout).not.toContain("LANDING: siglongjmp resumed");
    },
  );

  it("resumes the same SjLj tag across a non-noexcept boundary", async () => {
    const result = await runCentralizedProgram({
      programPath: noexceptFixture,
      argv: ["dinit_sjlj_noexcept_boundary", "--permissive"],
      timeout: 10_000,
      useDefaultRootfs: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("HANDLER: siglongjmp");
    expect(result.stdout).toContain("LANDING: siglongjmp resumed");
    expect(result.stderr).not.toContain("libc++abi: terminating");
  });

  it("reaps SIGCHLD after siglongjmp resumes the pselect landing pad", async () => {
    const result = await runCentralizedProgram({
      programPath: fixture,
      argv: ["dinit_sigchld_sjlj"],
      timeout: 10_000,
      useDefaultRootfs: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "PASS: SIGCHLD siglongjmp resumed at pselect landing pad",
    );
    expect(result.stderr).not.toContain("libc++abi: terminating");
  });
});

describe.skipIf(!dinit)("dinit SIGCHLD supervision", () => {
  it("completes a scripted service after reaping its child", async () => {
    const rootfs = readFileSync(resolveBinary("rootfs.vfs"));
    const fs = MemoryFileSystem.fromImage(
      new Uint8Array(rootfs.buffer, rootfs.byteOffset, rootfs.byteLength),
    );
    addDinitInit(
      fs,
      [
        {
          name: "child",
          type: "scripted",
          command: "/bin/echo child-exited",
          restart: false,
        },
      ],
      { boot: false },
    );
    writeVfsBinary(
      fs,
      "/bin/echo",
      readFileSync(resolveBinary("programs/echo.wasm")),
      0o755,
    );

    let output = "";
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const decoder = new TextDecoder();
    const onOutput = (_pid: number, data: Uint8Array) => {
      output += decoder.decode(data);
      if (output.includes("[  OK  ] child")) resolveReady();
    };

    const host = new NodeKernelHost({
      maxWorkers: 4,
      rootfsImage: await fs.saveImage(),
      onStdout: onOutput,
      onStderr: onOutput,
    });
    await host.init(arrayBuffer(readFileSync(resolveBinary("kernel.wasm"))));

    let dinitPid = -1;
    const spawn = host.spawn(
      arrayBuffer(readFileSync(dinit!)),
      ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl", "child"],
      {
        onStarted: (pid) => {
          dinitPid = pid;
        },
      },
    );
    void spawn.catch(() => {});
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let terminatedStatus: number | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Dinit child-reap timeout\n${output}`)),
            10_000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (dinitPid > 0) {
        await host.terminateProcess(dinitPid, TERMINATED_BY_SIGTERM);
        terminatedStatus = await spawn;
      }
      await host.destroy();
    }

    expect(terminatedStatus).toBe(TERMINATED_BY_SIGTERM);
    expect(output).toContain("[  OK  ] child");
    expect(output).not.toContain("libc++abi: terminating");
  }, 30_000);
});
