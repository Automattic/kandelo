#!/usr/bin/env -S npx tsx

import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { NodeKernelHost } from "../../host/src/node-kernel-host";
import type { ClosedLazyAsset } from "../../host/src/vfs/closed-lazy-assets";
import {
  MemoryFileSystem,
  type LazyDownloadEvent,
  type SerializedLazyArchiveEntry,
} from "../../host/src/vfs/memory-fs";
import {
  assertPackageDeferredZipTreeState,
  derivePackageDeferredZipTree,
} from "../../host/src/vfs/package-deferred-tree";
import {
  HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
} from "../../host/src/homebrew-vfs-composer";
import {
  assertPendingTreeHomebrewBottleMirrorBinding,
  decodeHomebrewBottleMirrorPlan,
  loadHomebrewBottleMirrorBindings,
} from "../../scripts/homebrew-closed-lazy-assets";
import {
  assertHomebrewGuestLifecycleRevisions,
  createHomebrewGuestLifecyclePhaseOneScript,
  createHomebrewGuestLifecyclePhaseTwoScript,
  HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER,
  HOMEBREW_GUEST_LIFECYCLE_PHASE_TWO_MARKER,
  type HomebrewGuestLifecycleRevisions,
} from "./homebrew_guest_lifecycle_contract";
import {
  assertHomebrewGuestLifecycleCatalog,
  assertNoRepeatedLazyDownloads,
  assertNoUnexpectedHostDiagnostics,
  completedLazyDownloadUrls,
  omitCompletedClosedLazyAssets,
  resolveHomebrewGuestLifecycleShell,
} from "./homebrew_guest_lifecycle_runtime_contract";

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

interface RootfsRuntimeInputs {
  imageBytes: Uint8Array;
  shellBytes: Uint8Array;
  shellArgv0: string;
  lazyUrlBase: string;
  lazyAssets?: readonly ClosedLazyAsset[];
  bootstrapTransportUrl: string;
  bootstrapBytes: number;
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
const ROOTFS_EXPORT_QUIESCENCE_TIMEOUT_MS = 5_000;
const HOMEBREW_COMPOSITION_PATH = "/etc/kandelo/homebrew-vfs.json";

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const runtime = loadRootfsRuntimeInputs(options);
  const revisions = {
    coreRevision: options.coreRevision,
    canaryRevision: options.canaryRevision,
  };

  const phaseOneHost = createCapturedHost(runtime, options);
  let exportedImage: Uint8Array | undefined;
  let phaseOneCompletedUrls: ReadonlySet<string> | undefined;
  try {
    await phaseOneHost.host.init();
    const preflightStart = phaseOneHost.lazyDownloads.length;
    await runGuestScript({
      captured: phaseOneHost,
      shellBytes: runtime.shellBytes,
      shellArgv0: runtime.shellArgv0,
      script: "set -eu; test -n \"$BASH_VERSION\"; printf 'homebrew-lifecycle-offline-ok\\n'",
      marker: "homebrew-lifecycle-offline-ok",
      label: "Homebrew lifecycle image-owned shell preflight",
      timeoutMs: options.timeoutMs,
    });
    assertNoLazyDownload(
      phaseOneHost.lazyDownloads.slice(preflightStart),
      "image-owned shell preflight",
    );

    await runGuestScript({
      captured: phaseOneHost,
      shellBytes: runtime.shellBytes,
      shellArgv0: runtime.shellArgv0,
      script: createHomebrewGuestLifecyclePhaseOneScript(revisions),
      marker: HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER,
      label: "stock Homebrew guest lifecycle phase one",
      timeoutMs: options.timeoutMs,
    });
    assertSingleCompletedLazyDownload(
      phaseOneHost.lazyDownloads,
      runtime.bootstrapTransportUrl,
      runtime.bootstrapBytes,
      "phase-one Homebrew bootstrap",
    );
    phaseOneCompletedUrls = completedLazyDownloadUrls(
      phaseOneHost.lazyDownloads,
    );
    exportedImage = await exportRootfsAfterProcessTeardown(
      phaseOneHost.host,
      ROOTFS_EXPORT_QUIESCENCE_TIMEOUT_MS,
    );
  } finally {
    await phaseOneHost.host.destroy().catch(() => {});
    assertNoUnexpectedHostDiagnostics(
      phaseOneHost.output.diagnostics,
      "stock Homebrew guest lifecycle phase one host",
    );
  }
  if (exportedImage === undefined || phaseOneCompletedUrls === undefined) {
    throw new Error("phase one did not export a durable root filesystem");
  }

  const exportedFs = MemoryFileSystem.fromImage(exportedImage);
  const exportedShell = resolveHomebrewGuestLifecycleShell(exportedFs);
  const phaseTwoRuntime = {
    ...runtime,
    imageBytes: exportedImage,
    shellBytes: exportedShell.bytes,
    shellArgv0: exportedShell.argv0,
    // WHY: a rebooted image must own everything phase one materialized. Do not
    // leave those closed bytes available to hide an export durability defect.
    lazyAssets: omitCompletedClosedLazyAssets(
      runtime.lazyAssets,
      phaseOneCompletedUrls,
    ),
  };
  const phaseTwoHost = createCapturedHost(phaseTwoRuntime, options);
  try {
    await phaseTwoHost.host.init();
    await runGuestScript({
      captured: phaseTwoHost,
      shellBytes: phaseTwoRuntime.shellBytes,
      shellArgv0: phaseTwoRuntime.shellArgv0,
      script: createHomebrewGuestLifecyclePhaseTwoScript(revisions),
      marker: HOMEBREW_GUEST_LIFECYCLE_PHASE_TWO_MARKER,
      label: "stock Homebrew guest lifecycle phase two after rootfs reboot",
      timeoutMs: options.timeoutMs,
    });
    assertNoRepeatedLazyDownloads(
      phaseOneCompletedUrls,
      phaseTwoHost.lazyDownloads,
      "rebooted lifecycle",
    );
  } finally {
    await phaseTwoHost.host.destroy().catch(() => {});
    assertNoUnexpectedHostDiagnostics(
      phaseTwoHost.output.diagnostics,
      "stock Homebrew guest lifecycle phase two host",
    );
  }

  process.stdout.write(
    "homebrew_guest_lifecycle_node: stock install, reinstall, cross-tap " +
      "dependency, durable reboot, pinned upgrade state, uninstall, and " +
      "untap proof passed\n",
  );
}

function loadRootfsRuntimeInputs(options: Options): RootfsRuntimeInputs {
  const imageBytes = readRegularFile(options.imagePath, "main-shell VFS image");
  const bootstrapArchiveBytes = readRegularFile(
    options.bootstrapArchivePath,
    "Homebrew bootstrap archive",
  );
  const bootstrapEnvironmentBytes = readRegularFile(
    options.bootstrapEnvironmentPath,
    "Homebrew bootstrap environment",
  );
  const bootstrapSpec = parseJson(
    readRegularFile(options.bootstrapSpecPath, "Homebrew bootstrap tree spec"),
    options.bootstrapSpecPath,
  );
  const bootstrapTree = derivePackageDeferredZipTree(
    bootstrapSpec,
    bootstrapArchiveBytes,
  );
  const fs = MemoryFileSystem.fromImage(imageBytes);
  assertPackageDeferredZipTreeState(fs, bootstrapTree, "deferred");
  assertExactBytes(
    readVfsFile(fs, "/etc/homebrew/brew.env"),
    bootstrapEnvironmentBytes,
    "main-shell Homebrew environment",
  );
  const guestManifest = parseJson(
    readVfsFile(fs, HOMEBREW_COMPOSITION_PATH),
    HOMEBREW_COMPOSITION_PATH,
  );
  assertHomebrewGuestLifecycleCatalog(guestManifest, options.coreRevision);
  const shell = resolveHomebrewGuestLifecycleShell(fs);

  const allPendingTrees = fs
    .exportLazyArchiveEntries()
    .filter((tree) => tree.content !== undefined);
  const bottleTrees = allPendingTrees.filter((tree) =>
    tree.activation?.capabilities.some((capability) =>
      capability.startsWith("homebrew-bottle:"),
    ),
  );
  const bootstrapTrees = allPendingTrees.filter((tree) =>
    tree.activation?.capabilities.includes("homebrew:bootstrap"),
  );
  const unclassifiedTrees = allPendingTrees.filter(
    (tree) => !bottleTrees.includes(tree) && !bootstrapTrees.includes(tree),
  );
  if (bootstrapTrees.length !== 1 || unclassifiedTrees.length !== 0) {
    throw new Error(
      `lifecycle image has ${bootstrapTrees.length} pending Homebrew source ` +
        `trees and ${unclassifiedTrees.length} unclassified package trees`,
    );
  }

  const embeddedPlanBytes = readVfsFile(
    fs,
    HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
  );
  const embeddedPlan = decodeHomebrewBottleMirrorPlan(
    embeddedPlanBytes,
    HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
  );
  if (bottleTrees.length !== embeddedPlan.assets.length) {
    throw new Error(
      `lifecycle image has ${bottleTrees.length} pending bottle trees, while ` +
        `its mirror plan declares ${embeddedPlan.assets.length}`,
    );
  }
  assertPendingTreeHomebrewBottleMirrorBinding(bottleTrees, embeddedPlan);

  const lazyUrlBase = options.transportMode === "closed"
    ? "https://closed.kandelo.invalid/homebrew-guest-lifecycle/"
    : pathToFileURL(`${dirname(options.bootstrapArchivePath)}/`).toString();
  const bootstrapTransportUrl = new URL(
    bootstrapTree.descriptor.archive.url,
    lazyUrlBase,
  ).toString();
  const lazyAssets = options.transportMode === "closed"
    ? [
        ...loadHomebrewBottleMirrorBindings(
          options.bottleMirrorPlanPath!,
          embeddedPlanBytes,
          bottleTrees,
        ),
        {
          url: bootstrapTransportUrl,
          sha256: bootstrapTree.descriptor.archive.sha256,
          size: bootstrapTree.descriptor.archive.bytes,
          bytes: bootstrapArchiveBytes,
        },
      ]
    : undefined;

  return {
    imageBytes,
    shellBytes: shell.bytes,
    shellArgv0: shell.argv0,
    lazyUrlBase,
    ...(lazyAssets === undefined ? {} : { lazyAssets }),
    bootstrapTransportUrl,
    bootstrapBytes: bootstrapTree.descriptor.archive.bytes,
  };
}

function createCapturedHost(
  runtime: RootfsRuntimeInputs,
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
        env: [
          "PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin",
          "HOME=/home/user",
          "USER=user",
          "LOGNAME=user",
          "SHELL=/bin/bash",
          "TERM=dumb",
          "TMPDIR=/tmp",
          "HOMEBREW_NO_ANALYTICS=1",
          "HOMEBREW_NO_AUTO_UPDATE=1",
          "HOMEBREW_NO_ENV_HINTS=1",
          "HOMEBREW_NO_INSTALL_FROM_API=1",
          "GIT_TERMINAL_PROMPT=0",
        ],
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

async function exportRootfsAfterProcessTeardown(
  host: NodeKernelHost,
  timeoutMs: number,
): Promise<Uint8Array> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await host.exportRootfsImage();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !message.includes("no live or tearing-down processes") ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      // WHY: a process exit is observable before the worker has necessarily
      // finished its asynchronous teardown. Retry only that exact transient
      // state; the worker-owned snapshot gate remains the authority and still
      // rejects every non-quiescent export.
      await delay(20);
    }
  }
}

function assertSingleCompletedLazyDownload(
  events: readonly LazyDownloadEvent[],
  url: string,
  expectedBytes: number,
  label: string,
): void {
  const matches = events.filter((event) => event.url === url);
  const started = matches.filter((event) => event.status === "started");
  const completed = matches.filter((event) => event.status === "complete");
  const failed = matches.filter((event) => event.status === "error");
  if (
    started.length !== 1 ||
    completed.length !== 1 ||
    failed.length !== 0 ||
    matches[0]?.status !== "started" ||
    matches.at(-1)?.status !== "complete" ||
    started[0]?.loadedBytes !== 0 ||
    completed[0]?.loadedBytes !== expectedBytes
  ) {
    throw new Error(
      `${label} must fetch its exact lazy tree once; events=${JSON.stringify(matches)}`,
    );
  }
}

function assertNoLazyDownload(
  events: readonly LazyDownloadEvent[],
  label: string,
): void {
  if (events.length !== 0) {
    throw new Error(
      `${label} unexpectedly fetched ${events[0]!.url}`,
    );
  }
}

function readVfsFile(
  fs: MemoryFileSystem,
  path: string,
  expectedSize?: number,
): Uint8Array {
  const stat = fs.stat(path);
  const size = expectedSize ?? stat.size;
  if ((stat.mode & 0xf000) !== 0x8000 || stat.size !== size) {
    throw new Error(`${path} is not the expected regular file`);
  }
  const bytes = new Uint8Array(size);
  const fd = fs.open(path, 0, 0);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.read(
        fd,
        bytes.subarray(offset),
        null,
        bytes.byteLength - offset,
      );
      if (count <= 0) {
        throw new Error(`${path} ended after ${offset}/${bytes.byteLength} bytes`);
      }
      offset += count;
    }
  } finally {
    fs.close(fd);
  }
  return bytes;
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

function assertExactBytes(
  actual: Uint8Array,
  expected: Uint8Array,
  label: string,
): void {
  if (
    actual.byteLength !== expected.byteLength ||
    !actual.every((byte, index) => byte === expected[index])
  ) {
    throw new Error(`${label} differs from the resolved package output`);
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
