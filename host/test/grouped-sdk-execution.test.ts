import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { compileSdkFixture } from "./support/compile-sdk-fixture";
import { runCentralizedProgram } from './centralized-test-helper';

const repository = resolve(import.meta.dirname, "../..");
const registration = new URL("../node_modules/tsx/dist/esm/api/index.mjs", import.meta.url).href;
const entry = new URL("./fixtures/grouped-sdk-execution-worker.ts", import.meta.url).href;
const availableProbes = [
  { name: "grow-churn", source: "grouped-sdk-grow-churn.c", markers: ["grouped-sdk-grow-churn PASS 384 512"], partial: "", groupedOnly: true },
  { name: "exec-precommit-retire", source: "grouped-sdk-exec-rollback.c", markers: [], partial: "", groupedOnly: true },
  { name: "exec-precommit-stop", source: "grouped-sdk-exec-rollback.c", markers: [], partial: "", groupedOnly: true },
  { name: "exec-signal-pool", source: "grouped-sdk-exec-handoff.c", markers: [], partial: "", groupedOnly: true, oldExecThreads: true },
  { name: "exec-pool-rollback", source: "grouped-sdk-exec-rollback.c", markers: ["grouped-sdk-exec-rollback PASS 16 callback"], partial: "", groupedOnly: true },
  { name: "pthread-pool-rollback", source: "grouped-sdk-pthread-launch-rollback.c", markers: ["grouped-sdk-pthread-launch-rollback PASS 16"], partial: "", groupedOnly: true },
  { name: "fork-pool-rollback", source: "grouped-sdk-fork-launch-rollback.c", markers: ["grouped-sdk-fork-launch-rollback PASS 16"], partial: "", groupedOnly: true },
  { name: "fork-registration-rollback", source: "grouped-sdk-fork-launch-rollback.c", markers: ["grouped-sdk-fork-launch-rollback PASS 16"], partial: "", groupedOnly: true },
  { name: "fork-replay-rollback", source: "grouped-sdk-fork-launch-rollback.c", markers: ["grouped-sdk-fork-launch-rollback PASS 16"], partial: "", groupedOnly: true },
  { name: "shared-file", source: "grouped-sdk-shared-file.c", markers: ["grouped-sdk-shared-file PASS"], partial: "", groupedOnly: true },
  { name: "anonymous-shared", source: "grouped-sdk-anonymous-shared.c", markers: ["grouped-sdk-anonymous-shared PASS"], partial: "", groupedOnly: true },
  { name: "exec-signal-commit", source: "grouped-sdk-exec-handoff.c", markers: [], partial: "", groupedOnly: true, oldExecThreads: true },
  { name: "exec-signal-stopped", source: "grouped-sdk-exec-handoff.c", markers: [], partial: "", groupedOnly: true, oldExecThreads: true },
  { name: "exec-handoff-threads", source: "grouped-sdk-exec-handoff.c", markers: ["grouped-sdk-exec-handoff PASS 16"], partial: "", groupedOnly: true, oldExecThreads: true },
  { name: "exec-handoff", source: "grouped-sdk-exec-handoff.c", markers: ["grouped-sdk-exec-handoff PASS 16"], partial: "", groupedOnly: true },
  { name: "exec-virtual-rollback", source: "grouped-sdk-exec-rollback.c", markers: ["grouped-sdk-exec-rollback PASS 16 virtual"], partial: "", groupedOnly: true, targetMinimumPages: 256 },
  { name: "exec-allocation-rollback", source: "grouped-sdk-exec-rollback.c", markers: ["grouped-sdk-exec-rollback PASS 16 allocation"], partial: "", groupedOnly: true },
  { name: "exec-callback-rollback", source: "grouped-sdk-exec-rollback.c", markers: ["grouped-sdk-exec-rollback PASS 16 callback"], partial: "", groupedOnly: true },
  { name: "mapping", source: "grouped-sdk-mapping.c", markers: ["heap-ok\n", "protection-io-ok\n", "moving-remap-ok\n", "grouped-sdk-mapping PASS"], partial: "ordinary-protection-partial" },
  { name: "private-file", source: "grouped-sdk-private-file.c", markers: ["grouped-sdk-private-file PASS"], partial: "ordinary-private-file-growth-unsupported" },
  { name: "native-wait-exit", source: "grouped-sdk-native-wait-exit.c", markers: ["grouped-sdk-native-wait-exit PASS wait32-wait64-kill-peer-notify"], partial: "", groupedOnly: true },
  { name: "forced-exit", source: "grouped-sdk-forced-exit.c", markers: ["wait-blocked PASS", "wait-busy PASS", "wait-crash PASS", "grouped-sdk-forced-exit PASS"], partial: "", groupedOnly: true },
  { name: "fork", source: "grouped-sdk-fork.c", markers: ["grouped-fork-child PASS", "grouped-sdk-fork PASS"], partial: "", groupedOnly: true },
  { name: "pthread", source: "grouped-sdk-pthread.c", markers: ["grouped-sdk-pthread PASS tls-init-growth-wait32-wait64-join"], partial: "", groupedOnly: true },
  { name: "pthread-launch-rollback", source: "grouped-sdk-pthread-launch-rollback.c", markers: ["grouped-sdk-pthread-launch-rollback PASS 16"], partial: "", groupedOnly: true },
  { name: "pthread-constructor-failure", source: "grouped-sdk-pthread-launch-rollback.c", markers: [], partial: "", groupedOnly: true },
  { name: "pthread-rollback", source: "grouped-sdk-pthread-rollback.c", markers: ["grouped-sdk-pthread-rollback PASS"], partial: "", groupedOnly: true },
  { name: "pthread-churn", source: "grouped-sdk-pthread-churn.c", markers: ["grouped-sdk-pthread-churn PASS 256"], partial: "", groupedOnly: true },
];
const selectedProbe = process.env.KANDELO_GROUPED_SDK_PROBE;
const probes = selectedProbe ? availableProbes.filter(probe => probe.name === selectedProbe) : availableProbes;
if (!probes.length) throw Error('Unknown selected grouped SDK probe: ' + selectedProbe);

const fixtures = new Map<string, { ordinary: ReturnType<typeof compileSdkFixture>; groupedPath: string; execTargetPath?: string }>();

beforeAll(() => {
  for (const probe of probes) {
    const ordinary = compileSdkFixture(new URL(`./fixtures/${probe.source}`, import.meta.url), "oldExecThreads" in probe ? ["-DEXEC_OLD_THREADS"] : [], { forkInstrument: true });
    const groupedPath = `${ordinary.programPath}.grouped.wasm`;
    fixtures.set(probe.name, { ordinary, groupedPath });
    execFileSync(join(repository, "sdk/bin/wasm32posix-shared-memory"), [
      ordinary.programPath, "-o", groupedPath,
    ], { cwd: repository, stdio: "pipe" });
    if ('targetMinimumPages' in probe && probe.targetMinimumPages !== undefined) {
      const target = compileSdkFixture(new URL(`./fixtures/${probe.source}`, import.meta.url),
        [`-Wl,--initial-memory=${probe.targetMinimumPages * 65536}`], { forkInstrument: true });
      const targetPath = `${target.programPath}.grouped.wasm`;
      fixtures.set(`${probe.name}-target`, { ordinary: target, groupedPath: targetPath });
      execFileSync(join(repository, 'sdk/bin/wasm32posix-shared-memory'), [target.programPath, '-o', targetPath],
        { cwd: repository, stdio: 'pipe' });
      fixtures.get(probe.name)!.execTargetPath = targetPath;
    }
  }
}, 180_000);
afterAll(() => { for (const fixture of fixtures.values()) fixture.ordinary.cleanup(); });

if (!selectedProbe || ['fork', 'pthread', 'pthread-churn'].includes(selectedProbe)) it.each(['fork', 'pthread', 'pthread-churn'].filter(name => probes.some(probe => probe.name === name)))('runs the same %s C program through the normal ordinary Node host', async probe => {
  const fixture = fixtures.get(probe)!;
  const result = await runCentralizedProgram({ programPath: fixture.ordinary.programPath,
    argv: [`grouped-sdk-${probe}`, 'ordinary'], timeout: 30_000, maxPages: 2048, useDefaultRootfs: false });
  if (process.env.KANDELO_GROUPED_SDK_EVIDENCE) {
    mkdirSync(process.env.KANDELO_GROUPED_SDK_EVIDENCE, { recursive: true });
    writeFileSync(join(process.env.KANDELO_GROUPED_SDK_EVIDENCE, `${probe}-ordinary-production.json`), JSON.stringify(result, null, 2) + '\n');
  }
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.stderr).toBe('');
  if (probe === 'fork') expect(result.stdout).toContain('grouped-fork-child PASS');
  expect(result.stdout).toContain(`grouped-sdk-${probe} PASS`);
}, 90_000);

for (const probe of probes) for (const grouped of [false, true]) {
  if ('groupedOnly' in probe && probe.groupedOnly && !grouped) continue;
  it(`runs real SDK libc ${probe.name} in ${grouped ? "grouped" : "ordinary"} dedicated Workers`, async () => {
    const { ordinary, groupedPath, execTargetPath } = fixtures.get(probe.name)!;
    const worker = new Worker(`import {register} from ${JSON.stringify(registration)}; register(); await import(${JSON.stringify(entry)});`, {
      eval: true,
      workerData: { grouped, trace: true, rejectForkLaunchCount: probe.name.startsWith("fork-") ? 16 : undefined, rejectForkStage: probe.name === "fork-pool-rollback" ? "pool" : probe.name === "fork-replay-rollback" ? "replay" : "registration", forcedLifecycle: probe.name === "forced-exit", nativeWaitLifecycle: probe.name === "native-wait-exit", rejectThreadLaunchCount: probe.name === "pthread-launch-rollback" ? 16 : undefined, threadPoolRollback: probe.name === "pthread-pool-rollback",
        uncertainThreadConstructor: probe.name === "pthread-constructor-failure", physicalPages: ["pthread-rollback", "exec-allocation-rollback"].includes(probe.name) ? 196 : undefined,
        maximumVirtualPages: probe.name === 'exec-virtual-rollback' ? 160 : undefined, execTargetPath, execSuccess: probe.name === 'exec-handoff' || probe.name === 'exec-handoff-threads' || probe.name.startsWith('exec-signal-'), execOldThreads: probe.name === 'exec-handoff-threads' || probe.name.startsWith('exec-signal-'),
        anonymousShared: probe.name === 'anonymous-shared', execTerminationPool: probe.name === 'exec-signal-pool', execSignal: probe.name === 'exec-signal-commit' ? 'commit' : ['exec-signal-stopped', 'exec-signal-pool'].includes(probe.name) ? 'stopped' : undefined,
        execPrecommitStop: probe.name === 'exec-precommit-stop' ? 'deactivate' : probe.name === 'exec-precommit-retire' ? 'retire' : undefined, execPoolRollback: probe.name === 'exec-pool-rollback', execPrecommitFailure: probe.name === 'exec-allocation-rollback' ? 'allocation' : ['exec-callback-rollback', 'exec-pool-rollback', 'exec-precommit-stop', 'exec-precommit-retire'].includes(probe.name) ? 'callback' : probe.name === 'exec-virtual-rollback' ? 'virtual' : undefined, imageModulePath: join(repository, "local-binaries/kandelo_image_module32.wasm"), kernelPath: resolveBinary("kernel.wasm"),
        ordinaryPath: ordinary!.programPath, programPath: grouped ? groupedPath : ordinary!.programPath },
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.once("exit", code => reject(new Error(`kernel Worker exited before result (${code})`)));
        deadline = setTimeout(() => reject(new Error("kernel Worker execution deadline")), 75_000);
      });
      if (process.env.KANDELO_GROUPED_SDK_EVIDENCE) {
        mkdirSync(process.env.KANDELO_GROUPED_SDK_EVIDENCE, { recursive: true });
        writeFileSync(join(process.env.KANDELO_GROUPED_SDK_EVIDENCE, `${probe.name}-${grouped ? 'grouped' : 'ordinary'}.json`),
          JSON.stringify(result, null, 2) + '\n');
      }
      if (probe.name === 'pthread-constructor-failure') {
        expect(result.failureMessage).toBe('Failed grouped thread has no execution-stop proof');
        expect(result.stdout).toBe('');
        expect(result.kernelExit).toBeUndefined();
        expect(result.processExit).toBeUndefined();
        expect(result.failedThreadLaunches).toEqual([expect.objectContaining({ cause: 'Error: fixture uncertain thread constructor' })]);
        expect(result.failedThreadWorkers).toEqual([expect.objectContaining({ executionAbsent: false, quiescent: false, joined: false })]);
        expect(result.threadConstructionAttempts).toBe(1);
        expect(result.memory).toMatchObject({ backing: { images: 1, replicas: 2, quarantinedReplicas: 2 } });
        expect(result.memory).toMatchObject({ snapshot: 'before-fatal-latch', inspectionError: 'Error: Failed grouped thread has no execution-stop proof' });
        expect(result.retirement).toBeUndefined();
        return;
      }
      expect(result.failure, JSON.stringify(result)).toBeUndefined();
      expect(result.diagnostics).toEqual([]);
      expect(result.stderr).toBe("");
      if (['exec-precommit-stop', 'exec-precommit-retire'].includes(probe.name)) {
        expect(result.kernelExit).toBe(137);
        expect(result.processExit).toBeUndefined();
        expect(result.quiescent).toBe(true);
        expect(result.processWorkerConstructionAttempts).toBe(1);
        expect(result.execReplacementPublications).toBe(0);
        expect(result.execHandoffs).toEqual([]);
        expect(result.execReturns).toEqual([]);
        expect(result.execPreparations).toHaveLength(1);
        const events = result.lifecycleEvidence as any[];
        expect(events.filter(row => row.kind === 'precommit-stop-pool-lock-released')).toEqual([
          expect.objectContaining({ admission: expect.objectContaining({ processes: 1, tasks: 1, images: 2 }) }),
        ]);
        expect(events.filter(row => row.kind === 'precommit-stopped-image-deactivated')).toHaveLength(1);
        expect(events.filter(row => row.kind === 'precommit-live-refused')).toEqual([expect.objectContaining({ backing: expect.objectContaining({ images: 2, replicas: 2, exposedReplicas: 1 }) })]);
        expect(events.filter(row => row.kind === 'precommit-host-references-released')).toHaveLength(probe.name === 'exec-precommit-retire' ? 1 : 0);
        expect(result.retirement).toMatchObject({ after: { backing: { allocatedPages: 1, images: 0, replicas: 0, nativeObservers: 0 } } });
        return;
      }
      if (probe.name === 'grow-churn') {
        expect(result.children).toHaveLength(3);
        expect((result.children as any[]).every(child => child.kernelExit === 0 && child.processExit === 0 && child.ready && child.quiescent)).toBe(true);
        // Four images plus a fixed 4 MiB allowance for controls and mapping
        // work. More cycles must reuse frames within this workload budget.
        expect((result.retirement as any).after.backing.physicalExtentPages)
          .toBeLessThanOrEqual(4 * (result.memory as any).initialVirtualPages + 64);
      }
      if (probe.name === 'exec-pool-rollback') {
        const locks = (result.lifecycleEvidence as any[]).filter(row => row.kind === 'exec-pool-lock-released');
        expect(locks).toHaveLength(16);
        expect(locks.every(row => row.admission.processes === 1 && row.admission.tasks === 2 && row.admission.images === 2)).toBe(true);
      }
      if (probe.name === 'pthread-pool-rollback') {
        const locks = (result.lifecycleEvidence as any[]).filter(row => row.kind === 'thread-pool-lock-released');
        expect(locks).toHaveLength(16);
        expect(locks.every(row => row.admission.processes === 1 && row.admission.tasks === 2 && row.admission.images === 1)).toBe(true);
        expect(result.threadConstructionAttempts).toBe(16);
      }
      if (probe.name === 'exec-signal-pool') {
        const locks = (result.lifecycleEvidence as any[]).filter(row => row.kind === 'terminated-exec-pool-lock-released');
        expect(locks).toHaveLength(1);
        expect(locks[0].admission).toMatchObject({ processes: 1, images: 2 });
        expect(locks[0].admission.tasks).toBeGreaterThanOrEqual(1);
      }
      if (probe.name.startsWith('exec-signal-')) {
        expect(result.kernelExit).toBe(137);
        expect(result.processExit).toBeUndefined();
        expect(result.execTermination).toEqual({ signal: 9 });
        expect(result.execReplacementPublications).toBe(0);
        expect(result.processWorkerConstructionAttempts).toBe(1);
        expect(result.execHandoffs).toEqual([]);
        expect(result.quiescent).toBe(true);
        expect(result.threads).toHaveLength(3);
        expect((result.threads as any[]).every(thread => thread.quiescent && thread.retired && thread.stoppedWithProcess)).toBe(true);
        expect(result.execLedger).toMatchObject({ processes: 0, tasks: 0, images: 0 });
        expect(result.retirement).toMatchObject({ after: { backing: { allocatedPages: 1, images: 0, replicas: 0, nativeObservers: 0 } } });
        const events = result.lifecycleEvidence as any[];
        expect(events.filter(row => row.kind === 'exec-old-threads-observed')).toHaveLength(1);
        expect(events.filter(row => row.kind === 'exec-old-threads-stopped')).toHaveLength(1);
        expect(events.filter(row => row.kind === 'exec-termination-published')).toHaveLength(1);
        expect(events.filter(row => row.kind === 'exec-late-exit-held')).toEqual([
          expect.objectContaining({ signal: 9, repeated: 9, backing: expect.objectContaining({ images: 1 }) }),
        ]);
        expect(events.filter(row => row.kind === 'exec-late-exit-finished')).toEqual([
          expect.objectContaining({ code: 137 }),
        ]);
        const sent = events.find(row => row.kind === 'exec-signal-sent');
        expect(sent.stopped).toBe(probe.name === 'exec-signal-commit' ? 0 : 3);
        return;
      }
      expect(result.kernelExit).toBe(0);
      expect(result.processExit).toBe(0);
      expect(result.processReady).toBe(true);
      expect(result.quiescent).toBe(true);
      if (grouped) expect(result.retirement).toMatchObject({ after: { backing: { allocatedPages: 1, images: 0, replicas: 0, nativeObservers: 0 } } });
      for (const marker of probe.markers) expect(result.stdout).toContain(marker);
      if (probe.name.startsWith('fork-')) {
        expect(result.forkWorkerConstructionAttempts).toBe(probe.name === 'fork-replay-rollback' ? 17 : 1);
        if (probe.name === 'fork-pool-rollback') {
          const locks = (result.lifecycleEvidence as any[]).filter(row => row.kind === 'fork-pool-lock-released');
          expect(locks).toHaveLength(16);
          expect(locks.every(row => row.admission.processes === 2 && row.admission.tasks === 2 && row.admission.images === 2)).toBe(true);
        }
        expect(result.injectedForkRefusals).toBe(16);
        const rows = result.rolledBackForks as any[];
        expect(rows).toHaveLength(16);
        expect(rows.every(row => row.backing.images === 1 && row.backing.replicas === 1 && row.backing.nativeObservers === 0)).toBe(true);
        expect(new Set(rows.map(row => row.backing.allocatedPages)).size).toBe(1);
      }
      // Retain ordinary protection/private-growth limits explicitly. Grouped
      // acceptance requires enforcement and retained file-backed growth.
      if (probe.partial) expect(String(result.stdout).includes(probe.partial)).toBe(!grouped);
      if (probe.name === 'exec-handoff' || probe.name === 'exec-handoff-threads') {
        expect(result.processWorkerConstructionAttempts).toBe(17);
        const samples = result.execHandoffs as any[];
        expect(samples).toHaveLength(16);
        if (probe.name === 'exec-handoff-threads') {
          expect(result.threads).toHaveLength(48);
          expect((result.threads as any[]).every(thread => thread.quiescent && thread.retired && thread.stoppedWithProcess)).toBe(true);
          expect((result.lifecycleEvidence as any[]).filter(row => row.kind === 'exec-old-threads-observed')).toHaveLength(16);
          expect((result.lifecycleEvidence as any[]).filter(row => row.kind === 'exec-old-threads-stopped')).toHaveLength(16);
        }
        expect(samples.every(row => row.backing.images === 1 && row.backing.replicas === 1)).toBe(true);
        expect(new Set(samples.slice(-8).map(row => row.backing.physicalExtentPages)).size).toBe(1);
      } else if (probe.name.startsWith('exec-')) {
        const returns = result.execReturns as any[], prepared = result.execPreparations as any[];
        expect(returns).toHaveLength(16);
        expect(result.execLedger).toMatchObject({ images: 1, tasks: 0, processes: 1 });
        expect(prepared).toHaveLength(['exec-callback-rollback', 'exec-pool-rollback'].includes(probe.name) ? 16 : 0);
        expect(prepared.every(row => row.backing.images === 2 && row.backing.replicas === 2 && row.backing.exposedReplicas === 1)).toBe(true);
        expect(returns.every(row => row.backing.images === 1 && row.backing.replicas === 1)).toBe(true);
        expect(new Set(returns.slice(1).map(row => row.backing.physicalExtentPages)).size).toBe(1);
      }
      if (probe.name === 'native-wait-exit') {
        expect(result.children).toEqual([137, 31].map(kernelExit => expect.objectContaining({ kernelExit, ready: true, quiescent: true })));
        const threads = result.threads as any[];
        expect(threads).toHaveLength(4);
        const victim = (result.children as any[])[0].pid;
        expect(threads.filter(row => row.pid === victim)).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ exited: false, stoppedWithProcess: true, quiescent: true, retired: true })));
        expect(threads.filter(row => row.pid !== victim)).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ quiescent: true, retired: true })));
        expect(threads.every(row => row.exited || row.stoppedWithProcess)).toBe(true);
        const evidence = result.lifecycleEvidence as any[];
        expect(evidence.filter(row => row.kind === 'native-waits-registered')).toHaveLength(1);
        expect(evidence.filter(row => row.kind === 'native-survivor-preserved')).toHaveLength(1);
        expect(evidence.filter(row => row.kind === 'kernel-exit-after-stop')).toHaveLength(2);
      }
      if (probe.name === 'forced-exit') {
        expect(result.children).toEqual([137, 137, 139].map(kernelExit => expect.objectContaining({ kernelExit, ready: true, quiescent: true })));
        const evidence = result.lifecycleEvidence as any[];
        expect(evidence.filter(row => row.kind === 'blocked-park')).toHaveLength(1);
        expect(evidence.filter(row => row.kind === 'busy-progress')).toHaveLength(1);
        expect(evidence.filter(row => row.kind === 'kernel-exit-after-stop')).toHaveLength(3);
        expect(evidence.filter(row => row.kind === 'actual-wasm-crash')).toHaveLength(1);
        expect(evidence.filter(row => row.kind === 'busy-still-stopped')).toHaveLength(1);
      }
      if (probe.name === 'anonymous-shared') {
        expect(result.children).toEqual([expect.objectContaining({ kernelExit: 23, processExit: 23, ready: true, quiescent: true })]);
        const events = result.lifecycleEvidence as any[], phases = events.filter(row => row.kind === 'anonymous-shared-phase');
        expect(phases.map(row => row.phase)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(phases.map(row => [row.backing.sharedObjects, row.backing.sharedPages, row.backing.sharedImageReferences]))
          .toEqual([[2,4,2], [2,4,4], [2,4,4], [2,4,3], [1,1,1], [0,0,0]]);
        expect(events.filter(row => row.kind === 'shared-child-retired')).toHaveLength(1);
        expect(result.retirement).toMatchObject({ after: { backing: { allocatedPages: 1, sharedObjects: 0, sharedPages: 0, sharedImageReferences: 0 } } });
      }
      if (probe.name === 'fork') {
        expect(result.children).toEqual([expect.objectContaining({ kernelExit: 23, processExit: 23, ready: true, quiescent: true, joined: true })]);
      }
      if (probe.name === 'pthread-launch-rollback') {
        expect(result.failedThreadLaunches).toHaveLength(16);
        expect(result.failedThreadWorkers).toEqual(Array.from({ length: 16 }, () => expect.objectContaining({ executionAbsent: true, quiescent: true, joined: false })));
        expect(result.threadConstructionAttempts).toBe(16);
        expect(result.threads).toEqual(Array.from({ length: 16 }, () => expect.objectContaining({ logicalExited: true, quiescent: true, retired: true })));
        const samples = result.threadRetirementMemory as any[];
        expect(samples).toHaveLength(16);
        expect(new Set(samples.slice(-8).map(row => row.backing.physicalExtentPages)).size).toBe(1);
      }
      if (probe.name === 'pthread-rollback') {
        expect(result.failedThreadLaunches).toEqual([expect.objectContaining({
          cause: 'Error: Cannot prepare grouped pthread: errno 12',
          before: expect.objectContaining({ maximumVirtualPages: 2048, backing: expect.objectContaining({ maximumPages: 196, allocatedPages: 192 }) }),
          after: expect.objectContaining({ backing: expect.objectContaining({ allocatedPages: 196 }) }),
        })]);
        expect(result.threads).toEqual([expect.objectContaining({ logicalExited: true, quiescent: true, retired: true })]);
      }
      if (probe.name === 'pthread-churn') {
        expect(result.threads).toEqual(Array.from({ length: 256 }, () => expect.objectContaining({ logicalExited: true, quiescent: true, retired: true })));
        const samples = result.threadRetirementMemory as any[];
        expect(samples).toHaveLength(256);
        const extents = samples.slice(-128).map(row => row.backing.physicalExtentPages);
        expect(new Set(extents).size, JSON.stringify(extents)).toBe(1);
      }
      if (probe.name === 'pthread') {
        expect(result.threads).toEqual(Array.from({ length: 6 }, () => expect.objectContaining({ logicalExited: true, quiescent: true, joined: true })));
      }
    } finally {
      if (deadline) clearTimeout(deadline);
      await worker.terminate();
    }
  }, 90_000);
}

if (!selectedProbe || ['pthread', 'fork', 'forced-exit', 'native-wait-exit', 'anonymous-shared'].includes(selectedProbe)) it.each(['pthread', 'fork', 'forced-exit', 'native-wait-exit', 'anonymous-shared'].filter(name => probes.some(probe => probe.name === name)))('reuses one backing for forty SDK %s cohorts after exact retirement', async probe => {
  const { ordinary, groupedPath } = fixtures.get(probe)!;
  const worker = new Worker(`import {register} from ${JSON.stringify(registration)}; register(); await import(${JSON.stringify(entry)});`, {
    eval: true, workerData: { grouped: true, cycles: 40, anonymousShared: probe === "anonymous-shared", forcedLifecycle: probe === "forced-exit", nativeWaitLifecycle: probe === "native-wait-exit", imageModulePath: join(repository, 'local-binaries/kandelo_image_module32.wasm'), kernelPath: resolveBinary('kernel.wasm'),
      ordinaryPath: ordinary.programPath, programPath: groupedPath },
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<any>((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject);
      worker.once('exit', code => reject(Error(`kernel Worker exited before cycles (${code})`)));
      deadline = setTimeout(() => reject(Error('SDK pthread cycle deadline')), 180_000);
    });
    if (process.env.KANDELO_GROUPED_SDK_EVIDENCE) {
      mkdirSync(process.env.KANDELO_GROUPED_SDK_EVIDENCE, { recursive: true });
      writeFileSync(join(process.env.KANDELO_GROUPED_SDK_EVIDENCE, `${probe}-cycles.json`), JSON.stringify(result, null, 2) + '\n');
    }
    expect(result.failure, JSON.stringify(result)).toBeUndefined();
    expect(result.cycles).toHaveLength(40);
    expect(new Set(result.cycles.map((row: any) => row.memory.group)).size).toBe(1);
    expect(new Set(result.cycles.map((row: any) => row.memory.pid)).size).toBe(40);
    for (const row of result.cycles) {
      expect(row.failure, JSON.stringify(row)).toBeUndefined();
      expect(row.kernelExit).toBe(0); expect(row.processExit).toBe(0);
      expect(row.stdout).toContain(`grouped-sdk-${probe} PASS`);
      if (probe === 'anonymous-shared') {
        expect(row.lifecycleEvidence.filter((event: any) => event.kind === 'anonymous-shared-phase')
          .map((event: any) => [event.phase, event.backing.sharedObjects, event.backing.sharedPages, event.backing.sharedImageReferences]))
          .toEqual([[1,2,4,2], [2,2,4,4], [3,2,4,4], [4,2,4,3], [5,1,1,1], [6,0,0,0]]);
        expect(row.memory.backing).toMatchObject({ sharedObjects: 0, sharedPages: 0, sharedImageReferences: 0 });
      }
      expect(row.stderr).toBe(''); expect(row.diagnostics).toEqual([]);
      if (probe === 'pthread') expect(row.threads).toEqual(Array.from({ length: 6 }, () => expect.objectContaining({ logicalExited: true, quiescent: true, joined: true })));
      else if (probe === 'native-wait-exit') {
        expect(row.children).toEqual([137, 31].map(kernelExit => expect.objectContaining({ kernelExit, ready: true, quiescent: true })));
        expect(row.threads).toHaveLength(4);
        expect(row.threads.every((thread: any) => thread.joined)).toBe(true);
        expect(row.threads.every((thread: any) => thread.quiescent && thread.retired)).toBe(true);
        expect(row.threads.filter((thread: any) => thread.pid === row.children[0].pid)).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ stoppedWithProcess: true, exited: false })));
        expect(row.threads.every((thread: any) => thread.exited || thread.stoppedWithProcess)).toBe(true);
        expect(row.lifecycleEvidence.filter((event: any) => event.kind === 'native-survivor-preserved')).toHaveLength(1);
      }
      else if (probe === 'forced-exit') {
        expect(row.children).toEqual([137, 137, 139].map(kernelExit => expect.objectContaining({ kernelExit, ready: true, quiescent: true, joined: true })));
        expect(row.lifecycleEvidence.filter((event: any) => event.kind === 'kernel-exit-after-stop')).toHaveLength(3);
      } else expect(row.children).toEqual([expect.objectContaining({ kernelExit: 23, processExit: 23, ready: true, quiescent: true, joined: true })]);
      expect(row.memory).toMatchObject({ maximumVirtualPages: 2048, declaredThreadSlots: probe === 'pthread' || probe === 'native-wait-exit' ? 1024 : 0,
        backing: { allocatedPages: 1, images: 0, replicas: 0, nativeObservers: 0 } });
    }
    const extents = result.cycles.slice(-20).map((row: any) => row.memory.backing.physicalExtentPages);
    expect(new Set(extents).size, JSON.stringify(extents)).toBe(1);
  } finally { if (deadline) clearTimeout(deadline); await worker.terminate(); }
}, 240_000);
