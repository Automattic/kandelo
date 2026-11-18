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
  { name: "mapping", source: "grouped-sdk-mapping.c", markers: ["heap-ok\n", "protection-io-ok\n", "moving-remap-ok\n", "grouped-sdk-mapping PASS"], partial: "ordinary-protection-partial" },
  { name: "private-file", source: "grouped-sdk-private-file.c", markers: ["grouped-sdk-private-file PASS"], partial: "ordinary-private-file-growth-partial" },
  { name: "fork", source: "grouped-sdk-fork.c", markers: ["grouped-fork-child PASS", "grouped-sdk-fork PASS"], partial: "", groupedOnly: true },
  { name: "pthread", source: "grouped-sdk-pthread.c", markers: ["grouped-sdk-pthread PASS tls-init-growth-wait32-wait64-join"], partial: "", groupedOnly: true },
];
const fixtures = new Map<string, { ordinary: ReturnType<typeof compileSdkFixture>; groupedPath: string }>();

beforeAll(() => {
  for (const probe of probes) {
    const ordinary = compileSdkFixture(new URL(`./fixtures/${probe.source}`, import.meta.url), [], { forkInstrument: true });
    const groupedPath = `${ordinary.programPath}.grouped.wasm`;
    fixtures.set(probe.name, { ordinary, groupedPath });
    execFileSync(join(repository, "sdk/bin/wasm32posix-shared-memory"), [
      ordinary.programPath, "-o", groupedPath,
    ], { cwd: repository, stdio: "pipe" });
  }
}, 180_000);
afterAll(() => { for (const fixture of fixtures.values()) fixture.ordinary.cleanup(); });

it.each(['fork', 'pthread'])('runs the same %s C program through the normal ordinary Node host', async probe => {
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
    const { ordinary, groupedPath } = fixtures.get(probe.name)!;
    const worker = new Worker(`import {register} from ${JSON.stringify(registration)}; register(); await import(${JSON.stringify(entry)});`, {
      eval: true,
      workerData: { grouped, trace: true, kernelPath: resolveBinary("kernel.wasm"),
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
      expect(result.failure, JSON.stringify(result)).toBeUndefined();
      expect(result.diagnostics).toEqual([]);
      expect(result.stderr).toBe("");
      expect(result.kernelExit).toBe(0);
      expect(result.processExit).toBe(0);
      expect(result.processReady).toBe(true);
      expect(result.quiescent).toBe(true);
      for (const marker of probe.markers) expect(result.stdout).toContain(marker);
      // Retain ordinary protection/private-growth limits explicitly. Grouped
      // acceptance requires enforcement and retained file-backed growth.
      if (probe.partial) expect(String(result.stdout).includes(probe.partial)).toBe(!grouped);
      if (probe.name === 'fork') {
        expect(result.children).toEqual([expect.objectContaining({ kernelExit: 23, processExit: 23, ready: true, quiescent: true, joined: true })]);
      }
      if (probe.name === 'pthread') {
        expect(result.threads).toEqual(Array.from({ length: 6 }, () => expect.objectContaining({ exited: true, quiescent: true, joined: true })));
      }
    } finally {
      if (deadline) clearTimeout(deadline);
      await worker.terminate();
    }
  }, 90_000);
}
