#!/usr/bin/env -S npx tsx

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { NodeKernelHost } from "../../host/src/node-kernel-host";
import {
  MemoryFileSystem,
  type LazyDownloadEvent,
} from "../../host/src/vfs/memory-fs";
import { assertHomebrewBottleMirrorPlan } from "../../host/src/homebrew-vfs-composer";
import {
  assertPackageDeferredZipTreeState,
  derivePackageDeferredZipTree,
} from "../../host/src/vfs/package-deferred-tree";
import {
  loadHomebrewBottleMirrorBindings,
} from "../../scripts/homebrew-closed-lazy-assets";
import {
  assertHomebrewGuestLifecycleRevisions,
  type HomebrewGuestLifecycleRevisions,
} from "./homebrew_guest_lifecycle_contract";
import {
  assertNoUnexpectedHostDiagnostics,
} from "./homebrew_guest_lifecycle_runtime_contract";
import {
  HOMEBREW_GUEST_LIFECYCLE_ENV,
  type HomebrewGuestLifecycleMachine,
  runHomebrewGuestLifecycle,
} from "./homebrew_guest_lifecycle_runner";
import {
  deriveHomebrewGuestLifecycleRuntimeInputs,
  type HomebrewGuestLifecycleRuntimeInputs,
} from "./homebrew_guest_lifecycle_runtime_inputs";

interface Options extends HomebrewGuestLifecycleRevisions {
  imagePath: string;
  bootstrapSpecPath: string;
  bootstrapArchivePath: string;
  bootstrapEnvironmentPath: string;
  transportMode: "closed" | "public";
  bottleMirrorPlanPath?: string;
  timeoutMs: number;
  traceProcessesFromPid?: number;
}

interface CapturedHost {
  host: NodeKernelHost;
  lazyDownloads: LazyDownloadEvent[];
  output: {
    stdout: string;
    stderr: string;
    diagnostics: string[];
    limitExceeded: boolean;
  };
}

const MAX_CAPTURED_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURED_DIAGNOSTICS = 1_000;

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const runtime = loadRootfsRuntimeInputs(options);
  const revisions = {
    coreRevision: options.coreRevision,
    canaryRevision: options.canaryRevision,
  };

  await runHomebrewGuestLifecycle({
    runtime,
    revisions,
    timeoutMs: options.timeoutMs,
    createMachine: (machineRuntime) =>
      createNodeLifecycleMachine(machineRuntime, options),
  });

  process.stdout.write(
    "homebrew_guest_lifecycle_node: stock install, reinstall, cross-tap " +
      "dependency, durable reboot, pinned upgrade state, uninstall, and " +
      "untap proof passed\n",
  );
}

function loadRootfsRuntimeInputs(
  options: Options,
): HomebrewGuestLifecycleRuntimeInputs {
  const imageBytes = readRegularFile(options.imagePath, "main-shell VFS image");
  const bootstrapArchiveBytes = readRegularFile(
    options.bootstrapArchivePath,
    "Homebrew bootstrap archive",
  );
  const bootstrapEnvironmentBytes = readRegularFile(
    options.bootstrapEnvironmentPath,
    "Homebrew bootstrap environment",
  );
  const bootstrapSpecBytes = readRegularFile(
    options.bootstrapSpecPath,
    "Homebrew bootstrap tree spec",
  );
  // Node can afford to re-derive the complete ZIP inventory synchronously.
  // Chromium binds Web-Crypto-verified bytes to this same serialized tree
  // contract without importing Node's crypto implementation.
  const bootstrapTree = derivePackageDeferredZipTree(
    parseJson(bootstrapSpecBytes, options.bootstrapSpecPath),
    bootstrapArchiveBytes,
  );
  assertPackageDeferredZipTreeState(
    MemoryFileSystem.fromImage(imageBytes),
    bootstrapTree,
    "deferred",
  );
  const bootstrapArchiveSha256 = createHash("sha256")
    .update(bootstrapArchiveBytes)
    .digest("hex");
  const lazyUrlBase = options.transportMode === "closed"
    ? "https://closed.kandelo.invalid/homebrew-guest-lifecycle/"
    : pathToFileURL(`${dirname(options.bootstrapArchivePath)}/`).toString();
  return deriveHomebrewGuestLifecycleRuntimeInputs({
    imageBytes,
    bootstrapSpecBytes,
    bootstrapArchiveBytes,
    bootstrapArchiveSha256,
    bootstrapEnvironmentBytes,
    coreRevision: options.coreRevision,
    transportMode: options.transportMode,
    lazyUrlBase,
    validateEmbeddedBottlePlan: assertHomebrewBottleMirrorPlan,
    ...(options.transportMode === "public"
      ? {
          expectedBootstrapTransportUrl: pathToFileURL(
            options.bootstrapArchivePath,
          ).toString(),
        }
      : {
          loadClosedBottleAssets: (embeddedPlanBytes, pendingBottleTrees) =>
            loadHomebrewBottleMirrorBindings(
              options.bottleMirrorPlanPath!,
              embeddedPlanBytes,
              pendingBottleTrees,
            ),
        }),
  });
}

function createCapturedHost(
  runtime: HomebrewGuestLifecycleRuntimeInputs,
  options: Options,
): CapturedHost {
  const lazyDownloads: LazyDownloadEvent[] = [];
  const output = {
    stdout: "",
    stderr: "",
    diagnostics: [] as string[],
    limitExceeded: false,
  };
  let outputBytes = 0;
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  const tracedProcesses = new Set<number>();
  let host: NodeKernelHost;
  const capture = (bytes: Uint8Array, stream: "stdout" | "stderr") => {
    outputBytes += bytes.byteLength;
    if (outputBytes > MAX_CAPTURED_OUTPUT_BYTES) {
      output.limitExceeded = true;
      return;
    }
    const decoder = stream === "stdout" ? stdoutDecoder : stderrDecoder;
    output[stream] += decoder.decode(bytes, { stream: true });
  };
  const traceProcess = async (event: {
    kind: "spawn" | "exec" | "exit";
    pid: number;
  }) => {
    if (
      options.traceProcessesFromPid === undefined ||
      event.pid < options.traceProcessesFromPid ||
      event.kind === "exit" ||
      tracedProcesses.has(event.pid)
    ) {
      return;
    }
    for (const delayMs of [0, 10, 50]) {
      if (delayMs !== 0) await delay(delayMs);
      const snapshot = (await host.enumProcs()).find(
        (process) => process.pid === event.pid,
      );
      if (snapshot === undefined) continue;
      tracedProcesses.add(event.pid);
      process.stderr.write(
        `homebrew-guest-lifecycle-process: pid=${snapshot.pid} ` +
          `ppid=${snapshot.ppid} state=${snapshot.state} ` +
          `cmdline=${JSON.stringify(snapshot.cmdline)}\n`,
      );
      return;
    }
  };
  host = new NodeKernelHost({
    maxWorkers: 8,
    rootfsImage: runtime.imageBytes,
    rootfsLazyUrlBase: runtime.lazyUrlBase,
    ...(runtime.lazyAssets === undefined
      ? {}
      : { rootfsLazyAssets: runtime.lazyAssets }),
    enableTcpNetwork: true,
    dataBufferSize: 1 << 20,
    onStdout: (_pid, bytes) => capture(bytes, "stdout"),
    onStderr: (_pid, bytes) => capture(bytes, "stderr"),
    onHostDiagnostic: (diagnostic) => {
      if (output.diagnostics.length < MAX_CAPTURED_DIAGNOSTICS) {
        output.diagnostics.push(diagnostic.message);
      }
    },
    onLazyDownload: (event) => lazyDownloads.push(event),
    onProcessEvent: (event) => {
      void traceProcess(event).catch((error) => {
        process.stderr.write(
          `homebrew-guest-lifecycle-process: trace failed: ${String(error)}\n`,
        );
      });
    },
  });
  return { host, lazyDownloads, output };
}

function createNodeLifecycleMachine(
  runtime: HomebrewGuestLifecycleRuntimeInputs,
  options: Options,
): HomebrewGuestLifecycleMachine {
  const captured = createCapturedHost(runtime, options);
  return {
    lazyDownloads: captured.lazyDownloads,
    diagnostics: captured.output.diagnostics,
    start: () => captured.host.init(),
    runShellScript: (scriptOptions) =>
      runGuestScript({ captured, ...scriptOptions }),
    exportRootfsImage: () => captured.host.exportRootfsImage(),
    destroy: () => captured.host.destroy(),
  };
}

async function runGuestScript(options: {
  captured: CapturedHost;
  shellBytes: Uint8Array;
  shellArgv0: string;
  script: string;
  marker: string;
  label: string;
  timeoutMs: number;
}): Promise<void> {
  const stdoutStart = options.captured.output.stdout.length;
  const stderrStart = options.captured.output.stderr.length;
  const diagnosticStart = options.captured.output.diagnostics.length;
  let pid: number | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exit = options.captured.host.spawn(
      toArrayBuffer(options.shellBytes),
      [options.shellArgv0, "-c", options.script],
      {
        env: [...HOMEBREW_GUEST_LIFECYCLE_ENV],
        cwd: "/home/user",
        uid: 1000,
        gid: 1000,
        stdin: new Uint8Array(),
        onStarted: (startedPid) => {
          pid = startedPid;
        },
      },
    );
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(
          new Error(`${options.label} timed out after ${options.timeoutMs}ms`),
        ),
        options.timeoutMs,
      );
    });
    const exitCode = await Promise.race([exit, timedOut]);
    const stdout = options.captured.output.stdout.slice(stdoutStart);
    const stderr = options.captured.output.stderr.slice(stderrStart);
    if (exitCode !== 0) {
      throw new Error(
        `${options.label} exited ${exitCode}; stdout=${JSON.stringify(stdout)}; ` +
          `stderr=${JSON.stringify(stderr)}; diagnostics=` +
          `${JSON.stringify(options.captured.output.diagnostics)}`,
      );
    }
    if (!stdout.split(/\r?\n/).includes(options.marker)) {
      throw new Error(
        `${options.label} marker is missing; stdout=${JSON.stringify(stdout)}; ` +
          `stderr=${JSON.stringify(stderr)}`,
      );
    }
    assertNoUnexpectedHostDiagnostics(
      options.captured.output.diagnostics.slice(diagnosticStart),
      options.label,
    );
    if (options.captured.output.limitExceeded) {
      throw new Error(
        `${options.label} exceeded the ${MAX_CAPTURED_OUTPUT_BYTES}-byte output limit`,
      );
    }
  } catch (error) {
    if (pid !== undefined) {
      await options.captured.host.terminateProcess(pid, 124).catch(() => {});
    }
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function readRegularFile(path: string, label: string): Uint8Array {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular non-symlink file: ${path}`);
  }
  return new Uint8Array(readFileSync(path));
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON: ${String(error)}`);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--image",
    "--homebrew-bootstrap-spec",
    "--homebrew-bootstrap-archive",
    "--homebrew-bootstrap-env",
    "--transport-mode",
    "--bottle-mirror-plan",
    "--core-revision",
    "--canary-revision",
    "--timeout-ms",
    "--trace-processes-from-pid",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      option === undefined ||
      value === undefined ||
      !allowed.has(option) ||
      values.has(option)
    ) {
      return usage();
    }
    values.set(option, value);
  }
  const image = values.get("--image");
  const bootstrapSpec = values.get("--homebrew-bootstrap-spec");
  const bootstrapArchive = values.get("--homebrew-bootstrap-archive");
  const bootstrapEnvironment = values.get("--homebrew-bootstrap-env");
  const transportMode = values.get("--transport-mode");
  const bottleMirrorPlan = values.get("--bottle-mirror-plan");
  const coreRevision = values.get("--core-revision");
  const canaryRevision = values.get("--canary-revision");
  const timeoutMs = Number(values.get("--timeout-ms") ?? "900000");
  const traceProcessesFromPid = values.has("--trace-processes-from-pid")
    ? Number(values.get("--trace-processes-from-pid"))
    : undefined;
  if (
    !image ||
    !bootstrapSpec ||
    !bootstrapArchive ||
    !bootstrapEnvironment ||
    !coreRevision ||
    !canaryRevision ||
    (transportMode !== "closed" && transportMode !== "public") ||
    (transportMode === "closed" && bottleMirrorPlan === undefined) ||
    (transportMode === "public" && bottleMirrorPlan !== undefined) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    (
      traceProcessesFromPid !== undefined &&
      (!Number.isSafeInteger(traceProcessesFromPid) ||
        traceProcessesFromPid < 1)
    )
  ) {
    return usage();
  }
  assertHomebrewGuestLifecycleRevisions({ coreRevision, canaryRevision });
  return {
    imagePath: resolve(image),
    bootstrapSpecPath: resolve(bootstrapSpec),
    bootstrapArchivePath: resolve(bootstrapArchive),
    bootstrapEnvironmentPath: resolve(bootstrapEnvironment),
    transportMode,
    ...(bottleMirrorPlan === undefined
      ? {}
      : { bottleMirrorPlanPath: resolve(bottleMirrorPlan) }),
    coreRevision,
    canaryRevision,
    timeoutMs,
    ...(traceProcessesFromPid === undefined
      ? {}
      : { traceProcessesFromPid }),
  };
}

function usage(): never {
  throw new Error(
    "usage: npx tsx homebrew/test/homebrew_guest_lifecycle_node.ts " +
      "--image <main-shell.vfs.zst> " +
      "--homebrew-bootstrap-spec <main-shell-brew-package-tree.json> " +
      "--homebrew-bootstrap-archive <homebrew-bootstrap.zip> " +
      "--homebrew-bootstrap-env <homebrew-brew.env> " +
      "--transport-mode <closed|public> " +
      "[--bottle-mirror-plan <kandelo-homebrew-bottle-mirror-plan.json>] " +
      "--core-revision <40-character SHA> " +
      "--canary-revision <40-character SHA> [--timeout-ms <N>] " +
      "[--trace-processes-from-pid <N>]",
  );
}

await main();
