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
const probes = [
  { name: "exec-virtual-rollback", source: "grouped-sdk-exec-rollback.c", markers: ["grouped-sdk-exec-rollback PASS 16 virtual"], partial: "", groupedOnly: true, targetMinimumPages: 256 },
  { name: "exec-allocation-rollback", source: "grouped-sdk-exec-rollback.c", markers: ["grouped-sdk-exec-rollback PASS 16 allocation"], partial: "", groupedOnly: true },
  { name: "exec-callback-rollback", source: "grouped-sdk-exec-rollback.c", markers: ["grouped-sdk-exec-rollback PASS 16 callback"], partial: "", groupedOnly: true },
  { name: "mapping", source: "grouped-sdk-mapping.c", markers: ["heap-ok\n", "protection-io-ok\n", "moving-remap-ok\n", "grouped-sdk-mapping PASS"], partial: "ordinary-protection-partial" },
  { name: "private-file", source: "grouped-sdk-private-file.c", markers: ["grouped-sdk-private-file PASS"], partial: "ordinary-private-file-growth-partial" },
  { name: "native-wait-exit", source: "grouped-sdk-native-wait-exit.c", markers: ["grouped-sdk-native-wait-exit PASS wait32-wait64-kill-peer-notify"], partial: "", groupedOnly: true },
  { name: "forced-exit", source: "grouped-sdk-forced-exit.c", markers: ["wait-blocked PASS", "wait-busy PASS", "wait-crash PASS", "grouped-sdk-forced-exit PASS"], partial: "", groupedOnly: true },
  { name: "fork", source: "grouped-sdk-fork.c", markers: ["grouped-fork-child PASS", "grouped-sdk-fork PASS"], partial: "", groupedOnly: true },
  { name: "pthread", source: "grouped-sdk-pthread.c", markers: ["grouped-sdk-pthread PASS tls-init-growth-wait32-wait64-join"], partial: "", groupedOnly: true },
  { name: "pthread-launch-rollback", source: "grouped-sdk-pthread-launch-rollback.c", markers: ["grouped-sdk-pthread-launch-rollback PASS 16"], partial: "", groupedOnly: true },
  { name: "pthread-constructor-failure", source: "grouped-sdk-pthread-launch-rollback.c", markers: [], partial: "", groupedOnly: true },
  { name: "pthread-rollback", source: "grouped-sdk-pthread-rollback.c", markers: ["grouped-sdk-pthread-rollback PASS"], partial: "", groupedOnly: true },
  { name: "pthread-churn", source: "grouped-sdk-pthread-churn.c", markers: ["grouped-sdk-pthread-churn PASS 256"], partial: "", groupedOnly: true },
];
const fixtures = new Map<string, { ordinary: ReturnType<typeof compileSdkFixture>; groupedPath: string; execTargetPath?: string }>();

beforeAll(() => {
  for (const probe of probes) {
    const ordinary = compileSdkFixture(new URL(`./fixtures/${probe.source}`, import.meta.url), [], { forkInstrument: true });
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

it.each(['fork', 'pthread', 'pthread-churn'])('runs the same %s C program through the normal ordinary Node host', async probe => {
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
      workerData: { grouped, trace: true, forcedLifecycle: probe.name === "forced-exit", nativeWaitLifecycle: probe.name === "native-wait-exit", rejectThreadLaunchCount: probe.name === "pthread-launch-rollback" ? 16 : undefined,
        uncertainThreadConstructor: probe.name === "pthread-constructor-failure", physicalPages: ["pthread-rollback", "exec-allocation-rollback"].includes(probe.name) ? 196 : undefined,
        maximumVirtualPages: probe.name === 'exec-virtual-rollback' ? 160 : undefined, execTargetPath,
        execPrecommitFailure: probe.name === 'exec-allocation-rollback' ? 'allocation' : probe.name === 'exec-callback-rollback' ? 'callback' : probe.name === 'exec-virtual-rollback' ? 'virtual' : undefined, kernelPath: resolveBinary("kernel.wasm"),
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
        expect(result.retirement).toBeUndefined();
        return;
      }
      expect(result.failure, JSON.stringify(result)).toBeUndefined();
      expect(result.diagnostics).toEqual([]);
      expect(result.stderr).toBe("");
      expect(result.kernelExit).toBe(0);
      expect(result.processExit).toBe(0);
      expect(result.processReady).toBe(true);
      expect(result.quiescent).toBe(true);
      if (grouped) expect(result.retirement).toMatchObject({ after: { backing: { allocatedPages: 1, images: 0, replicas: 0, nativeObservers: 0 } } });
      for (const marker of probe.markers) expect(result.stdout).toContain(marker);
      // Retain ordinary protection/private-growth limits explicitly. Grouped
      // acceptance requires enforcement and retained file-backed growth.
      if (probe.partial) expect(String(result.stdout).includes(probe.partial)).toBe(!grouped);
      if (probe.name.startsWith('exec-')) {
        const returns = result.execReturns as any[], prepared = result.execPreparations as any[];
        expect(returns).toHaveLength(16);
        expect(result.execLedger).toMatchObject({ images: 1, tasks: 0, processes: 1 });
        expect(prepared).toHaveLength(probe.name === 'exec-callback-rollback' ? 16 : 0);
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

it.each(['pthread', 'fork', 'forced-exit', 'native-wait-exit'])('reuses one backing for forty SDK %s cohorts after exact retirement', async probe => {
  const { ordinary, groupedPath } = fixtures.get(probe)!;
  const worker = new Worker(`import {register} from ${JSON.stringify(registration)}; register(); await import(${JSON.stringify(entry)});`, {
    eval: true, workerData: { grouped: true, cycles: 40, forcedLifecycle: probe === "forced-exit", nativeWaitLifecycle: probe === "native-wait-exit", kernelPath: resolveBinary('kernel.wasm'),
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
