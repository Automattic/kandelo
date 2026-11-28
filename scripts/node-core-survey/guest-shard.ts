import type { NodeKernelHost, NodeKernelHostOptions } from "../../host/src/node-kernel-host";
import type { ProcessGenerationEvent } from "../../host/src/process-generation-observation";

type GuestHost = Pick<NodeKernelHost,
  "init" | "destroy" | "spawnFromVfs" | "enumProcs" | "readFileFromVfs" |
  "writeFileToVfs" | "subscribeDestroyProgress" | "readOwnedJob" | "releaseOwnedJob"
>;
type Retired = Extract<ProcessGenerationEvent, { kind: "retired" }>;

const fixtureRoot = "/tmp/node-core-survey";
const python = "/usr/bin/python3";
const node = "/usr/bin/node";
const receiptFile = "/tmp/node-core-observations.jsonl";
const setupCode = [
  "import os, tarfile",
  "assert os.readlink('/usr/bin/node') == 'spidermonkey-node'",
  "assert os.path.realpath('/usr/bin/node') == '/usr/bin/spidermonkey-node'",
  "assert os.path.isfile('/usr/bin/spidermonkey-node')",
  `os.mkdir('${fixtureRoot}')`,
  "with tarfile.open('/tmp/node-core-fixtures.tar') as sources:",
  `    sources.extractall('${fixtureRoot}', filter='data')`,
].join("\n");

class Deadline extends Error {}

export async function before<T>(deadline: number, phase: string, work: () => Promise<T>): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Deadline(`${phase} exceeded its deadline`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Deadline(`${phase} exceeded its deadline`)), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runGuestShard(
  createHost: (options: NodeKernelHostOptions) => GuestHost,
  inputs: {
    image: Uint8Array;
    kernel: Uint8Array;
    readinessStartedAt?: number;
    shard?: { fixtures: Uint8Array; observer: Uint8Array; selectors: string[] };
  },
) {
  const started = inputs.readinessStartedAt ?? performance.now();
  const receipt = {
    environment: ["PATH=/usr/bin:/bin", "HOME=/root", "TMPDIR=/tmp", "LANG=C.UTF-8",
      "LC_ALL=C.UTF-8", "TZ=UTC", "PYTHONDONTWRITEBYTECODE=1"],
    uid: 0,
    gid: 0,
    automaticRetries: 0,
    processes: [] as Parameters<NonNullable<NodeKernelHostOptions["onProcessEvent"]>>[0][],
    generations: [] as ProcessGenerationEvent[],
    diagnostics: [] as Parameters<NonNullable<NodeKernelHostOptions["onHostDiagnostic"]>>[0][],
    invocations: [] as { phase: string; argv: string[]; pid?: number; exitStatus?: number;
      durationMs?: number; retirements?: Retired[]; stdout?: string; stderr?: string;
      processesAfter?: Awaited<ReturnType<GuestHost["enumProcs"]>>;
      jobStatus?: string; terminationObserved?: boolean }[],
    teardown: [] as unknown[],
    observations: null as string | null,
    outcome: "setup-error" as "setup-error" | "timeout" | "transport-error" | "finished",
    phase: "boot",
    error: null as string | null,
    teardownError: null as string | null,
  };
  const retirementWaiters = new Map<number, (event: Retired) => void>();
  const host = createHost({
    rootfsImage: inputs.image,
    onProcessEvent: event => receipt.processes.push(event),
    onHostDiagnostic: diagnostic => receipt.diagnostics.push(diagnostic),
    onProcessGenerationEvent: event => {
      receipt.generations.push(event);
      if (event.kind === "retired") {
        retirementWaiters.get(event.executionId)?.(event);
        retirementWaiters.delete(event.executionId);
      }
    },
  });
  host.subscribeDestroyProgress(event => receipt.teardown.push(event));

  function retirement(executionId: number) {
    const event = receipt.generations.find((candidate): candidate is Retired =>
      candidate.kind === "retired" && candidate.executionId === executionId);
    return event ? Promise.resolve(event) : new Promise<Retired>(resolve => {
      retirementWaiters.set(executionId, resolve);
    });
  }

  async function invoke(phase: string, argv: string[], cwd: string, deadline: number) {
    receipt.phase = phase;
    const firstGeneration = receipt.generations.length;
    const invocation: (typeof receipt.invocations)[number] = { phase, argv };
    receipt.invocations.push(invocation);
    const invokedAt = performance.now();
    const cutoff = Math.min(deadline, invokedAt + 120_000);
    try {
      return await before(cutoff, phase, async () => {
        const child = await host.spawnFromVfs(argv[0]!, argv, {
          env: receipt.environment, uid: receipt.uid, gid: receipt.gid, cwd,
          stdin: new Uint8Array(), ownedJob: { id: phase, timeoutMs: Math.max(1, Math.floor(cutoff - invokedAt)) },
        });
        invocation.pid = child.pid;
        invocation.exitStatus = await child.exit;
        const admissions = receipt.generations.slice(firstGeneration).filter(event => event.kind === "admitted");
        if (!admissions.some(event => event.pid === child.pid)) {
          throw new Error("No process generation was admitted for the invocation");
        }
        invocation.retirements = await Promise.all(admissions.map(event => retirement(event.executionId)));
        invocation.processesAfter = await host.enumProcs();
        let offset = 0;
        const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
        invocation.stdout = "";
        invocation.stderr = "";
        for (;;) {
          const page = await host.readOwnedJob(phase, offset, 65_536);
          if (page.expired || page.truncated) throw new Error("Guest command output exceeded the retained transport buffer");
          invocation.jobStatus = page.status;
          invocation.terminationObserved = page.terminationObserved;
          for (const chunk of page.chunks) {
            invocation[chunk.stream] += decoders[chunk.stream].decode(chunk.bytes, { stream: true });
          }
          if (!page.terminationObserved || page.exitCode !== invocation.exitStatus) {
            throw new Error("Guest command family exit or retirement was not fully observed");
          }
          if (page.status === "timed_out") throw new Deadline(`${phase} exceeded its deadline`);
          if (!page.hasMore) break;
          offset = page.next;
        }
        invocation.stdout += decoders.stdout.decode();
        invocation.stderr += decoders.stderr.decode();
        await host.releaseOwnedJob(phase);
        if (invocation.processesAfter.length !== 1 || invocation.processesAfter[0]?.pid !== 1 ||
            invocation.retirements.some(event => event.leaseDisposition !== "quiescent" ||
              event.mainFence !== "acknowledged" || event.threadFences === "missing" ||
              event.threads !== event.acknowledgedThreads || event.postCommitFailed)) {
          throw new Error("The original runner or a guest descendant did not retire cleanly");
        }
        return invocation.exitStatus;
      });
    } finally {
      invocation.durationMs = performance.now() - invokedAt;
    }
  }

  try {
    const readyBy = started + 180_000;
    const kernel = new Uint8Array(inputs.kernel).buffer;
    await before(readyBy, "boot", () => host.init(kernel));
    const profileProbe = [
      "const fs = require('node:fs');",
      "const assert = require('node:assert/strict');",
      "assert.equal(fs.readlinkSync('/usr/bin/node'), 'spidermonkey-node');",
      "assert.equal(fs.realpathSync('/usr/bin/node'), '/usr/bin/spidermonkey-node');",
      "console.log(JSON.stringify({version:process.version, platform:process.platform, arch:process.arch,",
      "  versions:process.versions, features:process.features, config:process.config.variables,",
      "  builtinModules:require('node:module').builtinModules.slice().sort(),",
      "  execPath:process.execPath, env:process.env}));",
    ].join("\n");
    if (await invoke("installed-node-profile", [node, "--eval", profileProbe], "/tmp", readyBy) !== 0) {
      throw new Error("Installed Node profile probe failed");
    }
    if (!inputs.shard) {
      receipt.outcome = "finished";
      return receipt;
    }
    const shard = inputs.shard;
    receipt.phase = "fixture-transfer";
    await before(readyBy, "fixture transfer", async () => {
      // A Node Buffer can use a pooled backing that worker transfer rejects.
      await host.writeFileToVfs("/tmp/node-core-fixtures.tar", new Uint8Array(shard.fixtures));
      await host.writeFileToVfs("/tmp/node-core-observer.py", new Uint8Array(shard.observer));
    });
    if (await invoke("fixture-setup", [python, "-c", setupCode], "/tmp", readyBy) !== 0) {
      throw new Error("Guest CPython could not stage the upstream fixtures or verify the installed symlink");
    }
    receipt.outcome = "transport-error";
    const gateDeadline = performance.now() + 1_200_000;
    await invoke("upstream-runner",
      [python, "/tmp/node-core-observer.py", receiptFile, node, "", ...shard.selectors],
      fixtureRoot, gateDeadline);
    receipt.phase = "receipt";
    const observations = await before(performance.now() + 60_000, "observation read", () =>
      host.readFileFromVfs(receiptFile));
    if (!observations) throw new Error("The guest runner did not return its observations");
    const decoded = new TextDecoder().decode(observations);
    if (receipt.diagnostics.length) {
      // Keep completed rows for diagnosis. The transport remains nonpassing.
      const complete = decoded.slice(0, decoded.lastIndexOf("\n") + 1);
      if (complete) receipt.observations = complete;
      throw new Error("Host diagnostics were reported during the guest run");
    }
    receipt.observations = decoded;
    receipt.outcome = "finished";
  } catch (error) {
    receipt.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    if (error instanceof Deadline) receipt.outcome = "timeout";
    // Keep complete observer records in the nonpassing receipt. At the time
    // of a deadline the runner may still be writing its final record.
    if (receipt.phase === "upstream-runner") {
      try {
        const observations = await before(performance.now() + 60_000, "partial observation read", () =>
          host.readFileFromVfs(receiptFile));
        if (observations) {
          const decoded = new TextDecoder().decode(observations);
          const complete = decoded.slice(0, decoded.lastIndexOf("\n") + 1);
          if (complete) receipt.observations = complete;
        }
      } catch (readError) {
        receipt.error += `\nCould not retain upstream observations: ${String(readError)}`;
      }
    }
  } finally {
    try {
      await before(performance.now() + 60_000, "session teardown", () => host.destroy());
    } catch (error) {
      receipt.teardownError = String(error);
    }
  }
  return receipt;
}
