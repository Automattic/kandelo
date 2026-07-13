/**
 * Browser test runner — runs individual wasm test programs via BrowserKernel.
 *
 * Exposes window.__runTest(wasmBytes) for Playwright to call.
 * Each call creates a fresh BrowserKernel, runs the program, cleans up,
 * and returns { exitCode, stdout, stderr }.
 */
import { BrowserKernel } from "@host/browser-kernel-host";
import pcmAudioWorkletUrl from "@host/audio/pcm-audio-worklet.js?url";
import {
  pcmControlWords,
  readConsumerPosition,
  readDiscardPosition,
  readPcmConfig,
  readProducerPosition,
  type PcmTransportDescriptor,
} from "@host/audio/pcm-transport";
import {
  createBuildFsWithEtc,
  finalizeKernelOwnedImage,
  settleWebKitReclaim,
} from "../../lib/kernel-owned-boot";
import kernelWasmUrl from "@kernel-wasm?url";
import dashWasmUrl from "@binaries/programs/wasm32/dash.wasm?url";
import coreutilsWasmUrl from "@binaries/programs/wasm32/coreutils.wasm?url";
import grepWasmUrl from "@binaries/programs/wasm32/grep.wasm?url";
import sedWasmUrl from "@binaries/programs/wasm32/sed.wasm?url";
import genCatWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/gencat.wasm?url";

interface DataFile {
  path: string;
  data?: number[]; // byte array (transferred as JSON-safe array)
  useWasmBytes?: boolean; // if true, use the wasmBytes as file content
}

interface AudioTestSnapshot {
  audioState: ReturnType<BrowserKernel["getAudioState"]>;
  audioStates: ReturnType<BrowserKernel["getAudioState"]>[];
  workletAssetUrl: string;
  workletPrepared: boolean;
  producerBytes: number;
  consumerBytes: number;
  discardBytes: number;
  queuedBytes: number;
  activeCapacityBytes: number;
  settled: boolean;
  resumeAttempts: number;
  trustedResumeAttempts: number;
  lastResumeError: string | null;
  stdout: string;
  stderr: string;
  hostDiagnostics: string[];
}

interface AudioTestResult extends AudioTestSnapshot {
  exitCode: number;
  elapsedMs: number;
}

interface AudioTestSession {
  kernel: BrowserKernel;
  transport: PcmTransportDescriptor;
  stdout: string;
  stderr: string;
  hostDiagnostics: string[];
  audioStates: ReturnType<BrowserKernel["getAudioState"]>[];
  workletPrepared: boolean;
  settled: boolean;
  resumeAttempts: number;
  trustedResumeAttempts: number;
  lastResumeError: string | null;
  result?: Promise<AudioTestResult>;
  unsubscribeAudioState?: () => void;
}

declare global {
  interface Window {
    __testRunnerReady: boolean;
    __runTest: (
      wasmBytes: ArrayBuffer,
      argv?: string[],
      timeoutMs?: number,
      options?: { dataFiles?: DataFile[]; cwd?: string; env?: string[] },
    ) => Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
      combined: string;
    }>;
    __testCount: number;
    /**
     * Start one real-browser `/dev/dsp` run with the AudioContext deliberately
     * suspended. The guest is allowed to fill the bounded PCM ring and block
     * in close; `#resume-audio` is the only path that resumes the audio clock.
     */
    __prepareAudioTest: (
      wasmBytes: ArrayBuffer,
      argv?: string[],
      timeoutMs?: number,
    ) => Promise<AudioTestSnapshot>;
    __audioTestSnapshot: () => AudioTestSnapshot;
    __waitForAudioTest: () => Promise<AudioTestResult>;
    __suspendAudioTest: () => Promise<AudioTestSnapshot>;
    __finishAudioTest: () => Promise<void>;
  }
}

// --- Tool binaries (pre-fetched at init) ---
let kernelWasmBytes: ArrayBuffer | null = null;
let dashBytes: ArrayBuffer | null = null;
let coreutilsBytes: ArrayBuffer | null = null;
let grepBytes: ArrayBuffer | null = null;
let sedBytes: ArrayBuffer | null = null;
let genCatBytes: ArrayBuffer | null = null;
let activeAudioTest: AudioTestSession | null = null;

const COREUTILS_NAMES = [
  "arch", "b2sum", "base32", "base64", "basename", "basenc", "cat",
  "chcon", "chgrp", "chmod", "chown", "chroot", "cksum", "comm", "cp",
  "csplit", "cut", "date", "dd", "df", "dir", "dircolors", "dirname",
  "du", "echo", "env", "expand", "expr", "factor", "false", "fmt",
  "fold", "groups", "head", "hostid", "id", "install", "join", "link",
  "ln", "logname", "ls", "md5sum", "mkdir", "mkfifo", "mknod", "mktemp",
  "mv", "nice", "nl", "nohup", "nproc", "numfmt", "od", "paste",
  "pathchk", "pr", "printenv", "printf", "ptx", "pwd", "readlink",
  "realpath", "rm", "rmdir", "runcon", "seq", "sha1sum", "sha224sum",
  "sha256sum", "sha384sum", "sha512sum", "shred", "shuf", "sleep",
  "sort", "split", "stat", "stty", "sum", "sync", "tac", "tail",
  "tee", "test", "timeout", "touch", "tr", "true", "truncate", "tsort",
  "tty", "uname", "unexpand", "uniq", "unlink", "vdir", "wc", "whoami",
  "yes",
];

/** Write a binary file to the virtual filesystem. */
function writeFileToFs(
  fs: import("@host/vfs/memory-fs").MemoryFileSystem,
  path: string,
  data: ArrayBuffer,
): void {
  const bytes = new Uint8Array(data);
  const fd = fs.open(path, 0x241 /* O_WRONLY|O_CREAT|O_TRUNC */, 0o755);
  fs.write(fd, bytes, null, bytes.length);
  fs.close(fd);
}

/** Populate VFS with actual executable binaries and symlinks for exec. */
function populateExecBinaries(fs: import("@host/vfs/memory-fs").MemoryFileSystem): void {
  for (const dir of ["/bin", "/usr", "/usr/bin", "/usr/local", "/usr/local/bin"]) {
    try { fs.mkdir(dir, 0o755); } catch { /* exists */ }
  }

  if (dashBytes) {
    writeFileToFs(fs, "/bin/dash", dashBytes);
    try { fs.symlink("/bin/dash", "/bin/sh"); } catch { /* exists */ }
    try { fs.symlink("/bin/dash", "/usr/bin/dash"); } catch { /* exists */ }
    try { fs.symlink("/bin/dash", "/usr/bin/sh"); } catch { /* exists */ }
  }

  if (coreutilsBytes) {
    writeFileToFs(fs, "/bin/coreutils", coreutilsBytes);
    for (const name of COREUTILS_NAMES) {
      try { fs.symlink("/bin/coreutils", `/bin/${name}`); } catch { /* exists */ }
      try { fs.symlink("/bin/coreutils", `/usr/bin/${name}`); } catch { /* exists */ }
    }
    try { fs.symlink("/bin/coreutils", "/bin/["); } catch { /* exists */ }
    try { fs.symlink("/bin/coreutils", "/usr/bin/["); } catch { /* exists */ }
  }

  if (grepBytes) {
    writeFileToFs(fs, "/bin/grep", grepBytes);
    try { fs.symlink("/bin/grep", "/bin/egrep"); } catch { /* exists */ }
    try { fs.symlink("/bin/grep", "/bin/fgrep"); } catch { /* exists */ }
    try { fs.symlink("/bin/grep", "/usr/bin/grep"); } catch { /* exists */ }
    try { fs.symlink("/bin/grep", "/usr/bin/egrep"); } catch { /* exists */ }
    try { fs.symlink("/bin/grep", "/usr/bin/fgrep"); } catch { /* exists */ }
  }

  if (sedBytes) {
    writeFileToFs(fs, "/bin/sed", sedBytes);
    try { fs.symlink("/bin/sed", "/usr/bin/sed"); } catch { /* exists */ }
  }

  if (genCatBytes) {
    writeFileToFs(fs, "/bin/gencat", genCatBytes);
    try { fs.symlink("/bin/gencat", "/usr/bin/gencat"); } catch { /* exists */ }
  }
}

function audioTransportFor(kernel: BrowserKernel): PcmTransportDescriptor {
  // The transport is intentionally not part of BrowserKernel's public app
  // API. This test-only page inspects it to prove that the production
  // AudioWorklet, rather than a main-thread timer or legacy pull drain,
  // advances the consumer clock.
  const transport = (
    kernel as unknown as { pcmTransport: PcmTransportDescriptor | null }
  ).pcmTransport;
  if (!transport) {
    throw new Error("PCM transport was not published by the kernel worker");
  }
  return transport;
}

function safeCursorNumber(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${label} PCM cursor is outside JavaScript's safe integer range`);
  }
  return number;
}

function snapshotAudioTest(session = activeAudioTest): AudioTestSnapshot {
  if (!session) throw new Error("No browser audio test is active");
  const words = pcmControlWords(session.transport);
  const producer = readProducerPosition(words);
  const consumer = readConsumerPosition(words);
  const discard = readDiscardPosition(words);
  const effectiveConsumer = consumer > discard ? consumer : discard;
  const config = readPcmConfig(words);
  return {
    audioState: session.kernel.getAudioState(),
    audioStates: session.audioStates.slice(),
    workletAssetUrl: pcmAudioWorkletUrl,
    workletPrepared: session.workletPrepared,
    producerBytes: safeCursorNumber(producer, "producer"),
    consumerBytes: safeCursorNumber(consumer, "consumer"),
    discardBytes: safeCursorNumber(discard, "discard"),
    queuedBytes: safeCursorNumber(
      producer > effectiveConsumer ? producer - effectiveConsumer : 0n,
      "queued",
    ),
    activeCapacityBytes: config.activeCapacityBytes,
    settled: session.settled,
    resumeAttempts: session.resumeAttempts,
    trustedResumeAttempts: session.trustedResumeAttempts,
    lastResumeError: session.lastResumeError,
    stdout: session.stdout,
    stderr: session.stderr,
    hostDiagnostics: session.hostDiagnostics.slice(),
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function finishAudioTest(): Promise<void> {
  const session = activeAudioTest;
  activeAudioTest = null;
  const resumeButton = document.getElementById("resume-audio") as HTMLButtonElement;
  resumeButton.disabled = true;
  document.getElementById("audio-status")!.textContent = "Audio test idle";
  if (!session) return;
  session.unsubscribeAudioState?.();
  await session.kernel.destroy().catch(() => {});
  await settleWebKitReclaim();
}

function installAudioResumeButton(): void {
  const resumeButton = document.getElementById("resume-audio") as HTMLButtonElement;
  resumeButton.addEventListener("click", (event) => {
    const session = activeAudioTest;
    if (!session) return;
    session.resumeAttempts++;
    if (event.isTrusted && navigator.userActivation?.isActive) {
      session.trustedResumeAttempts++;
    }
    session.lastResumeError = null;
    resumeButton.disabled = true;
    document.getElementById("audio-status")!.textContent = "Resuming audio...";
    void session.kernel.resumeAudio().then(
      () => {
        document.getElementById("audio-status")!.textContent = "Audio running";
      },
      (error) => {
        session.lastResumeError = error instanceof Error ? error.message : String(error);
        document.getElementById("audio-status")!.textContent =
          `Audio resume failed: ${session.lastResumeError}`;
        resumeButton.disabled = false;
      },
    );
  });
}

async function init() {
  // Fetch kernel wasm and tool binaries in parallel
  const fetches = await Promise.allSettled([
    fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
    fetch(dashWasmUrl).then((r) => r.arrayBuffer()),
    fetch(coreutilsWasmUrl).then((r) => r.arrayBuffer()),
    fetch(grepWasmUrl).then((r) => r.arrayBuffer()),
    fetch(sedWasmUrl).then((r) => r.arrayBuffer()),
    fetch(genCatWasmUrl).then((r) => r.arrayBuffer()),
  ]);
  kernelWasmBytes = fetches[0].status === "fulfilled" ? fetches[0].value : null;
  dashBytes = fetches[1].status === "fulfilled" ? fetches[1].value : null;
  coreutilsBytes = fetches[2].status === "fulfilled" ? fetches[2].value : null;
  grepBytes = fetches[3].status === "fulfilled" ? fetches[3].value : null;
  sedBytes = fetches[4].status === "fulfilled" ? fetches[4].value : null;
  genCatBytes = fetches[5].status === "fulfilled" ? fetches[5].value : null;

  if (!kernelWasmBytes) {
    throw new Error("Failed to fetch kernel wasm");
  }

  window.__testCount = 0;

  installAudioResumeButton();

  window.__prepareAudioTest = async (
    wasmBytes: ArrayBuffer,
    argv = ["audiotest"],
    timeoutMs = 30_000,
  ) => {
    await finishAudioTest();

    const buildFs = await createBuildFsWithEtc();
    const vfsImage = await finalizeKernelOwnedImage(buildFs);
    let session: AudioTestSession | null = null;
    const decoder = new TextDecoder();
    const hostDiagnostics: string[] = [];
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onStdout: (data: Uint8Array) => {
        if (session) session.stdout += decoder.decode(data);
      },
      onStderr: (data: Uint8Array) => {
        if (session) session.stderr += decoder.decode(data);
      },
      onHostDiagnostic: (diagnostic) => {
        hostDiagnostics.push(`${diagnostic.source}: ${diagnostic.message}`);
      },
    });

    try {
      await kernel.initFromImage({ kernelWasm: kernelWasmBytes!, vfsImage });
      session = {
        kernel,
        transport: audioTransportFor(kernel),
        stdout: "",
        stderr: "",
        hostDiagnostics,
        audioStates: [],
        workletPrepared: false,
        settled: false,
        resumeAttempts: 0,
        trustedResumeAttempts: 0,
        lastResumeError: null,
      };
      activeAudioTest = session;
      session.unsubscribeAudioState = kernel.onAudioStateChange((state) => {
        if (session && session.audioStates.at(-1) !== state) {
          session.audioStates.push(state);
        }
      });

      // Loading the default worklet URL is part of preparation. Force a
      // suspended starting point even in browsers whose autoplay policy lets
      // a newly-created context run, then queue guest PCM behind that clock.
      await kernel.prepareAudio();
      session.workletPrepared = true;
      await kernel.suspendAudio();
      const startedAt = performance.now();
      session.result = withTimeout(
        kernel.spawn(wasmBytes, argv, { env: ["SDL_AUDIODRIVER=dsp"] }),
        timeoutMs,
        "browser /dev/dsp guest",
      ).then((exitCode) => {
        if (!session) throw new Error("Browser audio session disappeared");
        session.settled = true;
        return {
          ...snapshotAudioTest(session),
          exitCode,
          elapsedMs: performance.now() - startedAt,
        };
      });

      const resumeButton = document.getElementById(
        "resume-audio",
      ) as HTMLButtonElement;
      resumeButton.disabled = false;
      document.getElementById("audio-status")!.textContent = "Audio suspended; PCM may queue";
      return snapshotAudioTest(session);
    } catch (error) {
      if (activeAudioTest === session) activeAudioTest = null;
      session?.unsubscribeAudioState?.();
      await kernel.destroy().catch(() => {});
      throw error;
    }
  };

  window.__audioTestSnapshot = () => snapshotAudioTest();
  window.__waitForAudioTest = async () => {
    const result = activeAudioTest?.result;
    if (!result) throw new Error("Browser audio test has not started");
    return result;
  };
  window.__suspendAudioTest = async () => {
    const session = activeAudioTest;
    if (!session) throw new Error("No browser audio test is active");
    await session.kernel.suspendAudio();
    const resumeButton = document.getElementById("resume-audio") as HTMLButtonElement;
    resumeButton.disabled = false;
    document.getElementById("audio-status")!.textContent = "Audio suspended";
    return snapshotAudioTest(session);
  };
  window.__finishAudioTest = finishAudioTest;

  window.__runTest = async (
    wasmBytes: ArrayBuffer,
    argv?: string[],
    timeoutMs = 30_000,
    options?: { dataFiles?: DataFile[]; cwd?: string; env?: string[] },
  ) => {
    let stdout = "";
    let stderr = "";
    let combined = "";

    // Assemble the test image (exec binaries + /etc + any data files) in a
    // transient build FS, then hand ownership to the kernel worker so the main
    // thread holds no VFS SharedArrayBuffer across the per-test loop.
    const buildFs = await createBuildFsWithEtc();
    populateExecBinaries(buildFs);
    if (options?.dataFiles) {
      for (const file of options.dataFiles) {
        // Ensure parent directories exist
        const parts = file.path.split("/").filter(Boolean);
        let dirPath = "";
        for (let i = 0; i < parts.length - 1; i++) {
          dirPath += "/" + parts[i];
          try {
            buildFs.mkdir(dirPath, 0o755);
          } catch {
            // Directory may already exist
          }
        }
        // Write the file — use wasmBytes if flagged, otherwise use provided data
        const fileData = file.useWasmBytes
          ? new Uint8Array(wasmBytes)
          : new Uint8Array(file.data!);
        const fd = buildFs.open(file.path, 0x241 /* O_WRONLY|O_CREAT|O_TRUNC */, 0o755);
        buildFs.write(fd, fileData, null, fileData.length);
        buildFs.close(fd);
      }
    }
    const vfsImage = await finalizeKernelOwnedImage(buildFs);

    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onStdout: (data: Uint8Array) => {
        const text = new TextDecoder().decode(data);
        stdout += text;
        combined += text;
      },
      onStderr: (data: Uint8Array) => {
        const text = new TextDecoder().decode(data);
        stderr += text;
        combined += text;
      },
    });

    try {
      await kernel.initFromImage({ kernelWasm: kernelWasmBytes!, vfsImage });

      // Run the test with a timeout
      const cwd = options?.cwd;
      const spawnOpts: { cwd?: string; env?: string[] } = {};
      if (cwd) spawnOpts.cwd = cwd;
      if (options?.env) spawnOpts.env = options.env;
      const exitCode = await Promise.race([
        kernel.spawn(wasmBytes, argv ?? ["test"], spawnOpts),
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs),
        ),
      ]);

      return { exitCode, stdout, stderr, combined };
    } finally {
      // Clean up to free memory for the next test
      await kernel.destroy();
      await settleWebKitReclaim();
      window.__testCount++;
    }
  };

  document.getElementById("status")!.textContent = "Ready";
  window.__testRunnerReady = true;
}

init().catch((err) => {
  document.getElementById("status")!.textContent = `Error: ${err.message}`;
  console.error("Test runner init failed:", err);
});
