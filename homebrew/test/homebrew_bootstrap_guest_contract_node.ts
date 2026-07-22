import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { NodeKernelHost } from "../../host/src/node-kernel-host";
import {
  createHomebrewBootstrapGuestContractScript,
  HOMEBREW_BOOTSTRAP_CONTRACT_MARKER,
  HOMEBREW_BOOTSTRAP_GUEST,
  HOMEBREW_BOOTSTRAP_GUEST_ENV,
} from "../../scripts/homebrew-bootstrap-guest-contract";

interface Options {
  image: string;
  bash: string;
  timeoutMs: number;
}

function usage(): never {
  throw new Error(
    "usage: homebrew_bootstrap_guest_contract_node.ts " +
      "--image <vfs> --bash <wasm> [--timeout-ms <N>]",
  );
}

function parseOptions(args: string[]): Options {
  const options = new Map<string, string>();
  const allowed = new Set(["image", "bash", "timeout-ms"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const name = flag?.startsWith("--") ? flag.slice(2) : "";
    if (!allowed.has(name) || options.has(name) || value === undefined) usage();
    options.set(name, value);
  }
  const image = options.get("image");
  const bash = options.get("bash");
  const timeoutMs = Number(options.get("timeout-ms") ?? "240000");
  if (!image || !bash || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) usage();
  return { image: resolve(image), bash: resolve(bash), timeoutMs };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const image = new Uint8Array(readFileSync(options.image));
  const bash = new Uint8Array(readFileSync(options.bash));
  const decoder = new TextDecoder();
  let stdout = "";
  let stderr = "";
  let pid: number | undefined;
  const hostDiagnostics: string[] = [];

  const host = new NodeKernelHost({
    rootfsImage: toArrayBuffer(image),
    enableTcpNetwork: false,
    dataBufferSize: 1 << 20,
    onStdout: (_pid, bytes) => {
      stdout += decoder.decode(bytes, { stream: true });
    },
    onStderr: (_pid, bytes) => {
      stderr += decoder.decode(bytes, { stream: true });
    },
    onHostDiagnostic: (diagnostic) => {
      hostDiagnostics.push(diagnostic.message);
    },
  });

  await host.init();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitPromise = host.spawn(
      toArrayBuffer(bash),
      ["/bin/bash", "-c", createHomebrewBootstrapGuestContractScript()],
      {
        env: [...HOMEBREW_BOOTSTRAP_GUEST_ENV],
        cwd: HOMEBREW_BOOTSTRAP_GUEST.cwd,
        uid: HOMEBREW_BOOTSTRAP_GUEST.uid,
        gid: HOMEBREW_BOOTSTRAP_GUEST.gid,
        onStarted: (startedPid) => {
          pid = startedPid;
        },
      },
    );
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`guest Homebrew contract timed out after ${options.timeoutMs}ms`)),
        options.timeoutMs,
      );
    });
    const exitCode = await Promise.race([exitPromise, timeoutPromise]);
    if (exitCode !== 0) {
      throw new Error(
        `guest Homebrew contract exited ${exitCode}; stdout=${JSON.stringify(stdout)}; ` +
          `stderr=${JSON.stringify(stderr)}; diagnostics=${JSON.stringify(hostDiagnostics)}`,
      );
    }
  } catch (error) {
    if (pid !== undefined) await host.terminateProcess(pid, 124).catch(() => {});
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    await host.destroy().catch(() => {});
  }

  if (!stdout.split(/\r?\n/).includes(HOMEBREW_BOOTSTRAP_CONTRACT_MARKER)) {
    throw new Error(
      `guest Homebrew contract marker is missing; stdout=${JSON.stringify(stdout)}; ` +
        `stderr=${JSON.stringify(stderr)}`,
    );
  }
  const reserveFailure = hostDiagnostics.find((message) =>
    message.includes("(FORK_SAVE_BUFFER_SIZE) are reserved"),
  );
  if (reserveFailure) {
    throw new Error(`guest Homebrew contract hit fork reserve: ${reserveFailure}`);
  }
  process.stdout.write("homebrew_bootstrap_guest_contract_node: pass\n");
}

await main();
