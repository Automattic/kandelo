import { BrowserKernel } from "@host/browser-kernel-host";
import type { SyscallTraceEvent } from "@host/kernel-worker";
import type { LazyDownloadEvent } from "@host/vfs/memory-fs";
import type { ClosedLazyAsset } from "@host/vfs/closed-lazy-assets";
import {
  assertHomebrewQueryFixture,
  commandScript,
  emptyProcessCounts,
  medianMetrics,
  summarizeLazyDownloads,
  type HomebrewQueryArtifact,
  type HomebrewQueryCommand,
  type HomebrewQueryCommandResult,
  type HomebrewQueryFixtureManifest,
  type HomebrewQueryNetworkAudit,
  type HomebrewQueryProcessCounts,
  type HomebrewQueryScenarioResult,
} from "../../../../benchmarks/homebrew-query/contracts";
import {
  runHomebrewQueryScenario,
  type HomebrewQueryMachine,
  type HomebrewQueryMachineFactory,
} from "../../../../benchmarks/homebrew-query/scenario";

declare global {
  interface Window {
    __homebrewQueryBenchmarkReady: boolean;
    __runHomebrewQueryBenchmark(
      rounds: number,
      auditNetwork?: boolean,
    ): Promise<{
      fixture: HomebrewQueryFixtureManifest;
      rounds: HomebrewQueryScenarioResult[];
      median: Record<string, number>;
    }>;
  }
}

interface ProcessEvent {
  kind: "spawn" | "exec" | "exit";
}

const COMMAND_TIMEOUT_MS = 10 * 60_000;
const logElement = document.getElementById("log")!;
const decoder = new TextDecoder("utf-8", { fatal: false });

function log(message: string): void {
  logElement.textContent += `${message}\n`;
  console.log(message);
}

async function prepare(): Promise<{
  fixture: HomebrewQueryFixtureManifest;
  factory: BrowserHomebrewQueryMachineFactory;
}> {
  const fixtureParameter = new URL(location.href).searchParams.get("fixture");
  if (!fixtureParameter) throw new Error("Homebrew benchmark fixture URL is missing");
  const fixtureUrl = new URL(fixtureParameter, location.href);
  const response = await fetch(fixtureUrl);
  if (!response.ok) throw new Error(`Fixture returned HTTP ${response.status}`);
  const fixture = await response.json();
  assertHomebrewQueryFixture(fixture);
  const kernel = await fetchVerifiedArtifact(fixtureUrl, fixture.kernel);
  const lazyAssets: ClosedLazyAsset[] = [];
  for (const artifact of fixture.lazyAssets) {
    lazyAssets.push({
      url: artifact.url,
      sha256: artifact.sha256,
      size: artifact.bytes,
      bytes: await fetchVerifiedArtifact(fixtureUrl, artifact),
    });
  }
  return {
    fixture,
    factory: new BrowserHomebrewQueryMachineFactory(
      fixtureUrl,
      fixture,
      kernel,
      lazyAssets,
    ),
  };
}

class BrowserHomebrewQueryMachineFactory
  implements HomebrewQueryMachineFactory {
  constructor(
    private readonly fixtureUrl: URL,
    private readonly fixture: HomebrewQueryFixtureManifest,
    private readonly kernel: Uint8Array,
    private readonly lazyAssets: ClosedLazyAsset[],
  ) {}

  async create(image: "lazy" | "eager"): Promise<HomebrewQueryMachine> {
    const artifact = image === "lazy"
      ? this.fixture.rootfs
      : this.fixture.eagerRootfs;
    if (!artifact) throw new Error("Eager Homebrew query image is unavailable");
    return new BrowserHomebrewQueryMachine(
      this.fixture,
      await fetchVerifiedArtifact(this.fixtureUrl, artifact),
      this.kernel,
      image === "lazy" ? this.lazyAssets : undefined,
    );
  }
}

class BrowserHomebrewQueryMachine implements HomebrewQueryMachine {
  private readonly stdout: Uint8Array[] = [];
  private readonly stderr: Uint8Array[] = [];
  private readonly processEvents: ProcessEvent[] = [];
  private readonly lazyEvents: LazyDownloadEvent[] = [];
  private readonly diagnostics: string[] = [];
  private readonly kernel: BrowserKernel;

  constructor(
    private readonly fixture: HomebrewQueryFixtureManifest,
    private readonly image: Uint8Array,
    private readonly kernelWasm: Uint8Array,
    private readonly lazyAssets?: ClosedLazyAsset[],
  ) {
    this.kernel = new BrowserKernel({
      maxWorkers: 4,
      kernelOwnedFs: true,
      onStdout: (value) => this.stdout.push(value.slice()),
      onStderr: (value) => this.stderr.push(value.slice()),
      onProcessEvent: (event) => this.processEvents.push(event),
      onLazyDownload: (event) => this.lazyEvents.push(event),
      onHostDiagnostic: (diagnostic) => {
        this.diagnostics.push(
          `pid=${diagnostic.pid} source=${diagnostic.source}: ` +
            diagnostic.message,
        );
      },
    });
  }

  async start(): Promise<number> {
    const startedAt = performance.now();
    await this.kernel.initFromOwnedImage({
      kernelWasm: wholeArrayBuffer(this.kernelWasm),
      vfsImage: wholeArrayBuffer(this.image),
      lazyUrlBase: this.fixture.lazyUrlBase,
      ...(this.lazyAssets === undefined
        ? {}
        : { closedLazyAssets: this.lazyAssets }),
    });
    return performance.now() - startedAt;
  }

  async run(command: HomebrewQueryCommand): Promise<HomebrewQueryCommandResult> {
    const stdoutStart = this.stdout.length;
    const stderrStart = this.stderr.length;
    const processStart = this.processEvents.length;
    const lazyStart = this.lazyEvents.length;
    const diagnosticStart = this.diagnostics.length;
    const startedAt = performance.now();
    const spawned = await this.kernel.spawnFromVfs(
      this.fixture.shell.path,
      [this.fixture.shell.argv0, "-l", "-c", commandScript(command)],
      {
        env: this.fixture.homebrew.environment,
        cwd: "/home/user",
        uid: 1000,
        gid: 1000,
        stdin: new Uint8Array(),
      },
    );
    // BrowserKernel's VFS spawn is a main-thread root event and therefore is
    // not echoed by the worker's fork/exec event stream.
    this.processEvents.push({ kind: "spawn" });
    const status = await withTimeout(
      spawned.exit,
      COMMAND_TIMEOUT_MS,
      `Homebrew query timed out: ${command.id}`,
    );
    const elapsedMs = performance.now() - startedAt;
    const stdout = concatenate(this.stdout.slice(stdoutStart));
    const stderr = concatenate(this.stderr.slice(stderrStart));
    const invalidQueryOutput = command.id !== "shell_boot" && (
      stdout.byteLength === 0 || stderr.byteLength !== 0
    );
    if (
      status !== 0 || invalidQueryOutput ||
      this.diagnostics.length !== diagnosticStart
    ) {
      throw new Error(
        `Homebrew query ${command.id} did not produce clean output ` +
          `(status=${status}, stdout=${stdout.byteLength}, ` +
          `stderr=${stderr.byteLength}): ` +
          decoder.decode(stderr).slice(-4_000) + "\n" +
          this.diagnostics.slice(diagnosticStart).join("\n"),
      );
    }
    return {
      id: command.id,
      argv: command.argv,
      elapsedMs,
      status,
      stdoutBytes: stdout.byteLength,
      stderrBytes: stderr.byteLength,
      stdoutSha256: await sha256(stdout),
      stderrSha256: await sha256(stderr),
      processCounts: countProcessEvents(this.processEvents.slice(processStart)),
      lazy: summarizeLazyDownloads(this.lazyEvents.slice(lazyStart)),
    };
  }

  async auditNetwork(
    commands: readonly HomebrewQueryCommand[],
  ): Promise<HomebrewQueryNetworkAudit> {
    const events: SyscallTraceEvent[] = [];
    const unsubscribe = this.kernel.subscribeSyscalls((event) => events.push(event));
    try {
      const output: HomebrewQueryNetworkAudit["commands"] = [];
      for (const command of commands) {
        const start = events.length;
        const result = await this.run(command);
        await delay(350);
        output.push({
          id: command.id,
          status: result.status,
          networkSyscalls: countNetworkSyscalls(events.slice(start)),
        });
      }
      return { commands: output };
    } finally {
      unsubscribe();
    }
  }

  async destroy(): Promise<void> {
    // WHY: this harness runs Chromium only. Avoid importing the WebKit
    // reclamation helper because that module also imports the repository's
    // default rootfs, while this benchmark must use only its verified fixture.
    await this.kernel.destroy();
  }
}

function countNetworkSyscalls(
  events: readonly SyscallTraceEvent[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const name = event.decoded?.match(
      /\]\s+(socket|connect|send|sendto|sendmsg|recv|recvfrom|recvmsg)\b/,
    )?.[1];
    if (name) counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

function countProcessEvents(
  events: readonly ProcessEvent[],
): HomebrewQueryProcessCounts {
  const counts = emptyProcessCounts();
  for (const event of events) counts[event.kind] += 1;
  return counts;
}

async function fetchVerifiedArtifact(
  fixtureUrl: URL,
  artifact: HomebrewQueryArtifact,
): Promise<Uint8Array> {
  const url = new URL(artifact.file, fixtureUrl);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const value = new Uint8Array(await response.arrayBuffer());
  if (value.byteLength !== artifact.bytes || await sha256(value) !== artifact.sha256) {
    throw new Error(`Homebrew query artifact changed identity: ${url}`);
  }
  return value;
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function wholeArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

async function sha256(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    wholeArrayBuffer(value),
  ));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const prepared = prepare();
window.__homebrewQueryBenchmarkReady = false;
window.__runHomebrewQueryBenchmark = async (roundCount, auditNetwork = true) => {
  if (!Number.isSafeInteger(roundCount) || roundCount <= 0) {
    throw new Error("Homebrew query rounds must be a positive integer");
  }
  const { fixture, factory } = await prepared;
  const rounds: HomebrewQueryScenarioResult[] = [];
  for (let index = 0; index < roundCount; index += 1) {
    log(`Homebrew query Chromium round ${index + 1}/${roundCount}`);
    rounds.push(await runHomebrewQueryScenario({
      fixture,
      machines: factory,
      auditNetwork: auditNetwork && index === 0,
    }));
  }
  return { fixture, rounds, median: medianMetrics(rounds) };
};
void prepared.then(
  () => {
    window.__homebrewQueryBenchmarkReady = true;
    log("Homebrew query benchmark ready");
  },
  (error) => {
    window.__homebrewQueryBenchmarkReady = true;
    log(`Homebrew query benchmark failed to prepare: ${String(error)}`);
  },
);
