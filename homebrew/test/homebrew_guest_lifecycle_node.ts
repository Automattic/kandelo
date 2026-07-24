import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ABI_VERSION } from "../../host/src/generated/abi";
import { NodeKernelHost } from "../../host/src/node-kernel-host";
import { MemoryFileSystem } from "../../host/src/vfs/memory-fs";
import {
  createHomebrewGuestLifecycleScript,
  HOMEBREW_GUEST_LIFECYCLE_ABI,
  HOMEBREW_GUEST_LIFECYCLE_GUEST,
  HOMEBREW_GUEST_LIFECYCLE_GUEST_ENV,
  HOMEBREW_GUEST_LIFECYCLE_MARKER,
  type HomebrewGuestCanaryIdentity,
} from "../../scripts/homebrew-guest-lifecycle-contract";

interface Options {
  image: string;
  bash: string;
  timeoutMs: number;
  canary: HomebrewGuestCanaryIdentity;
}

function usage(): never {
  throw new Error(
    "usage: homebrew_guest_lifecycle_node.ts --image <vfs> --bash <wasm> " +
      "--canary-revision <sha> --canary-formula-sha256 <sha256> " +
      "--canary-bottle-sha256 <sha256> --canary-bottle-rebuild <N> " +
      "[--timeout-ms <N>]",
  );
}

function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  const allowed = new Set([
    "image",
    "bash",
    "canary-revision",
    "canary-formula-sha256",
    "canary-bottle-sha256",
    "canary-bottle-rebuild",
    "timeout-ms",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const name = flag?.startsWith("--") ? flag.slice(2) : "";
    if (!allowed.has(name) || values.has(name) || value === undefined) usage();
    values.set(name, value);
  }

  const image = values.get("image");
  const bash = values.get("bash");
  const revision = values.get("canary-revision");
  const formulaSha256 = values.get("canary-formula-sha256");
  const bottleSha256 = values.get("canary-bottle-sha256");
  const bottleRebuild = Number(values.get("canary-bottle-rebuild"));
  const timeoutMs = Number(values.get("timeout-ms") ?? "900000");
  if (
    !image ||
    !bash ||
    !revision ||
    !formulaSha256 ||
    !bottleSha256 ||
    !Number.isSafeInteger(bottleRebuild) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000
  ) {
    usage();
  }
  return {
    image: resolve(image),
    bash: resolve(bash),
    timeoutMs,
    canary: { revision, formulaSha256, bottleSha256, bottleRebuild },
  };
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

  if (ABI_VERSION !== HOMEBREW_GUEST_LIFECYCLE_ABI) {
    throw new Error(
      `guest lifecycle requires ABI ${HOMEBREW_GUEST_LIFECYCLE_ABI}, ` +
        `but this checkout generates ABI ${ABI_VERSION}`,
    );
  }
  MemoryFileSystem.assertImageKernelAbi(
    image,
    HOMEBREW_GUEST_LIFECYCLE_ABI,
    "Homebrew guest lifecycle image",
  );

  const host = new NodeKernelHost({
    rootfsImage: toArrayBuffer(image),
    // Stock brew, Git, and GHCR must traverse the same guest socket path that
    // ordinary Kandelo software uses; a host-side download would not prove
    // Homebrew works inside the machine.
    enableTcpNetwork: true,
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
      ["/bin/bash", "-c", createHomebrewGuestLifecycleScript(options.canary)],
      {
        env: [...HOMEBREW_GUEST_LIFECYCLE_GUEST_ENV],
        cwd: HOMEBREW_GUEST_LIFECYCLE_GUEST.cwd,
        uid: HOMEBREW_GUEST_LIFECYCLE_GUEST.uid,
        gid: HOMEBREW_GUEST_LIFECYCLE_GUEST.gid,
        onStarted: (startedPid) => {
          pid = startedPid;
        },
      },
    );
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`guest Homebrew lifecycle timed out after ${options.timeoutMs}ms`)),
        options.timeoutMs,
      );
    });
    const exitCode = await Promise.race([exitPromise, timeoutPromise]);
    if (exitCode !== 0) {
      throw new Error(
        `guest Homebrew lifecycle exited ${exitCode}; stdout=${JSON.stringify(stdout)}; ` +
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

  if (!stdout.split(/\r?\n/).includes(HOMEBREW_GUEST_LIFECYCLE_MARKER)) {
    throw new Error(
      `guest Homebrew lifecycle marker is missing; stdout=${JSON.stringify(stdout)}; ` +
        `stderr=${JSON.stringify(stderr)}`,
    );
  }
  const reserveFailure = hostDiagnostics.find((message) =>
    message.includes("(FORK_SAVE_BUFFER_SIZE) are reserved"),
  );
  if (reserveFailure) {
    throw new Error(`guest Homebrew lifecycle hit fork reserve: ${reserveFailure}`);
  }
  process.stdout.write("homebrew_guest_lifecycle_node: pass\n");
}

await main();
