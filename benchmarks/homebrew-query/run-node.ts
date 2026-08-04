#!/usr/bin/env -S npx tsx

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { dirname, resolve } from "node:path";

import { NodeKernelHost } from "../../host/src/node-kernel-host";
import type { SyscallTraceEvent } from "../../host/src/kernel-worker";
import type { LazyDownloadEvent } from "../../host/src/vfs/memory-fs";
import type { ClosedLazyAsset } from "../../host/src/vfs/closed-lazy-assets";
import {
  assertHomebrewQueryFixture,
  commandScript,
  emptyProcessCounts,
  medianMetrics,
  summarizeLazyDownloads,
  type HomebrewQueryArtifact,
  type HomebrewQueryBenchmarkResult,
  type HomebrewQueryCommand,
  type HomebrewQueryCommandResult,
  type HomebrewQueryFixtureManifest,
  type HomebrewQueryNetworkAudit,
  type HomebrewQueryProcessCounts,
} from "./contracts";
import {
  runHomebrewQueryScenario,
  type HomebrewQueryMachine,
  type HomebrewQueryMachineFactory,
} from "./scenario";

interface Options {
  fixturePath: string;
  rounds: number;
  outputPath?: string;
}

interface ProcessEvent {
  kind: "spawn" | "exec" | "exit";
}

const COMMAND_TIMEOUT_MS = 10 * 60_000;
const decoder = new TextDecoder("utf-8", { fatal: false });

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const fixtureRoot = dirname(options.fixturePath);
  const fixture = JSON.parse(readFileSync(options.fixturePath, "utf-8"));
  assertHomebrewQueryFixture(fixture);
  const kernel = readVerifiedArtifact(fixtureRoot, fixture.kernel);
  const lazyAssets = fixture.lazyAssets.map((artifact) => ({
    url: artifact.url,
    sha256: artifact.sha256,
    size: artifact.bytes,
    bytes: readVerifiedArtifact(fixtureRoot, artifact),
  } satisfies ClosedLazyAsset));
  const factory = new NodeHomebrewQueryMachineFactory(
    fixtureRoot,
    fixture,
    kernel,
    lazyAssets,
  );
  const rounds = [];
  for (let index = 0; index < options.rounds; index += 1) {
    process.stderr.write(`Homebrew query Node round ${index + 1}/${options.rounds}\n`);
    rounds.push(await runHomebrewQueryScenario({
      fixture,
      machines: factory,
      auditNetwork: index === 0,
    }));
  }
  const result: HomebrewQueryBenchmarkResult = {
    schema: 1,
    kind: "kandelo-homebrew-query-benchmark-result",
    host: "node",
    hostVersion: process.version,
    kandeloCommit: gitHead(),
    recordedAt: new Date().toISOString(),
    machine: {
      platform: `${platform()} ${release()}`,
      architecture: arch(),
      cpu: cpus()[0]?.model ?? "unknown",
    },
    fixture,
    rounds,
    median: medianMetrics(rounds),
  };
  const encoded = `${JSON.stringify(result, null, 2)}\n`;
  if (options.outputPath) {
    mkdirSync(dirname(options.outputPath), { recursive: true });
    writeFileSync(options.outputPath, encoded);
    process.stderr.write(`Wrote ${options.outputPath}\n`);
  }
  process.stdout.write(encoded);
}

class NodeHomebrewQueryMachineFactory implements HomebrewQueryMachineFactory {
  constructor(
    private readonly fixtureRoot: string,
    private readonly fixture: HomebrewQueryFixtureManifest,
    private readonly kernel: Uint8Array,
    private readonly lazyAssets: ClosedLazyAsset[],
  ) {}

  async create(image: "lazy" | "eager"): Promise<HomebrewQueryMachine> {
    const artifact = image === "lazy"
      ? this.fixture.rootfs
      : this.fixture.eagerRootfs;
    if (!artifact) throw new Error("Eager Homebrew query image is unavailable");
    return new NodeHomebrewQueryMachine(
      this.fixture,
      readVerifiedArtifact(this.fixtureRoot, artifact),
      this.kernel,
      image === "lazy" ? this.lazyAssets : undefined,
    );
  }
}

class NodeHomebrewQueryMachine implements HomebrewQueryMachine {
  private readonly stdout: Uint8Array[] = [];
  private readonly stderr: Uint8Array[] = [];
  private readonly processEvents: ProcessEvent[] = [];
  private readonly lazyEvents: LazyDownloadEvent[] = [];
  private readonly host: NodeKernelHost;

  constructor(
    private readonly fixture: HomebrewQueryFixtureManifest,
    image: Uint8Array,
    private readonly kernel: Uint8Array,
    lazyAssets?: ClosedLazyAsset[],
  ) {
    this.host = new NodeKernelHost({
      maxWorkers: 4,
      rootfsImage: image,
      rootfsLazyUrlBase: fixture.lazyUrlBase,
      ...(lazyAssets === undefined ? {} : { rootfsLazyAssets: lazyAssets }),
      // A successful audited query with this backend disabled cannot have
      // depended on an external request.
      enableTcpNetwork: false,
      onStdout: (_pid, value) => this.stdout.push(value.slice()),
      onStderr: (_pid, value) => this.stderr.push(value.slice()),
      onProcessEvent: (event) => this.processEvents.push(event),
      onLazyDownload: (event) => this.lazyEvents.push(event),
    });
  }

  async start(): Promise<number> {
    const startedAt = performance.now();
    await this.host.init(wholeArrayBuffer(this.kernel));
    return performance.now() - startedAt;
  }

  async run(command: HomebrewQueryCommand): Promise<HomebrewQueryCommandResult> {
    const stdoutStart = this.stdout.length;
    const stderrStart = this.stderr.length;
    const processStart = this.processEvents.length;
    const lazyStart = this.lazyEvents.length;
    const startedAt = performance.now();
    const spawned = await this.host.spawnFromVfs(
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
    const status = await withTimeout(
      spawned.exit,
      COMMAND_TIMEOUT_MS,
      `Homebrew query timed out: ${command.id}`,
    );
    const elapsedMs = performance.now() - startedAt;
    const stdout = concatenate(this.stdout.slice(stdoutStart));
    const stderr = concatenate(this.stderr.slice(stderrStart));
    if (status !== 0) {
      throw new Error(
        `Homebrew query ${command.id} exited ${status}: ` +
          decoder.decode(stderr).slice(-4_000),
      );
    }
    return {
      id: command.id,
      argv: command.argv,
      elapsedMs,
      status,
      stdoutBytes: stdout.byteLength,
      stderrBytes: stderr.byteLength,
      stdoutSha256: sha256(stdout),
      stderrSha256: sha256(stderr),
      processCounts: countProcessEvents(this.processEvents.slice(processStart)),
      lazy: summarizeLazyDownloads(this.lazyEvents.slice(lazyStart)),
    };
  }

  async auditNetwork(
    commands: readonly HomebrewQueryCommand[],
  ): Promise<HomebrewQueryNetworkAudit> {
    const events: SyscallTraceEvent[] = [];
    const unsubscribe = this.host.subscribeSyscalls((event) => events.push(event));
    try {
      const output: HomebrewQueryNetworkAudit["commands"] = [];
      for (const command of commands) {
        const start = events.length;
        const result = await this.run(command);
        // Trace delivery is deliberately batched outside the syscall hot path.
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

  destroy(): Promise<void> {
    return this.host.destroy();
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

function readVerifiedArtifact(
  fixtureRoot: string,
  artifact: HomebrewQueryArtifact,
): Uint8Array {
  const path = resolve(fixtureRoot, artifact.file);
  const value = readFileSync(path);
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) {
    throw new Error(`Homebrew query artifact changed identity: ${path}`);
  }
  return bytes;
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

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function gitHead(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
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

function parseOptions(argv: string[]): Options {
  let fixturePath: string | undefined;
  let outputPath: string | undefined;
  let rounds = 3;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const [name, inline] = argument.split("=", 2);
    const value = inline ?? argv[++index];
    if (name === "--fixture") fixturePath = value;
    else if (name === "--output") outputPath = value;
    else if (name === "--rounds") rounds = Number(value);
    else usage(`Unknown argument: ${argument}`);
  }
  if (!fixturePath) usage("--fixture is required");
  if (!Number.isSafeInteger(rounds) || rounds <= 0) {
    usage("--rounds must be a positive integer");
  }
  return {
    fixturePath: resolve(fixturePath),
    rounds,
    ...(outputPath === undefined ? {} : { outputPath: resolve(outputPath) }),
  };
}

function usage(message: string): never {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    "Usage: npx tsx benchmarks/homebrew-query/run-node.ts " +
      "--fixture PATH [--rounds 3] [--output PATH]\n",
  );
  process.exit(2);
}

void main().catch((error) => {
  process.stderr.write(
    `homebrew-query Node failed: ${error instanceof Error ? error.stack : error}\n`,
  );
  process.exitCode = 1;
});
