#!/usr/bin/env npx tsx
/**
 * Before/after benchmark for the evdev injection path (#5).
 *
 * Measures the wall-clock cost of delivering a fixed number of evdev
 * records to a blocked reader inside the centralized kernel, comparing:
 *
 *   per-record : one `injectInputEvent` per record  (old behavior)
 *   batched    : one `injectInputEventBatch` per SYN_REPORT frame (new)
 *
 * Each pointer frame is three records (REL_X, REL_Y, SYN_REPORT). The
 * batched path crosses the worker boundary — and runs a kernel entry plus
 * a pending-reader wake scan — once per frame instead of once per record.
 *
 * The reader (`programs/input-inject-bench.c`) drains in waves and acks
 * each wave on stdout, so the per-OFD ring never overflows and both modes
 * deliver exactly the same records; the wall-clock delta is the injection
 * path alone.
 *
 * Usage: npx tsx benchmarks/input-injection-bench.ts [--frames-per-wave N]
 *        [--waves N] [--rounds N]
 */
import { readFileSync } from "node:fs";

import { NodeKernelHost } from "../host/src/node-kernel-host.js";
import { tryResolveBinary } from "../host/src/binary-resolver.js";
import type { InputEvent } from "../host/src/input/input-source.js";

const EV_SYN = 0x00;
const EV_REL = 0x02;
const SYN_REPORT = 0x00;
const REL_X = 0x00;
const REL_Y = 0x01;
const CANVAS_W = 1024;
const CANVAS_H = 768;
const KICK = new Uint8Array([0x0a]);

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
}

const FRAMES_PER_WAVE = arg("frames-per-wave", 300); // 900 records < 1024 cap
const WAVES = arg("waves", 60);
const ROUNDS = arg("rounds", 5);
const RECORDS_PER_WAVE = FRAMES_PER_WAVE * 3;

function pointerFrame(): InputEvent[] {
  return [
    { device: 1, ev_type: EV_REL, code: REL_X, value: 1 },
    { device: 1, ev_type: EV_REL, code: REL_Y, value: 1 },
    { device: 1, ev_type: EV_SYN, code: SYN_REPORT, value: 0 },
  ];
}

async function waitFor(
  ref: { value: string },
  needle: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ref.value.includes(needle)) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`timed out waiting for ${JSON.stringify(needle)}`);
}

async function runMode(
  mode: "per-record" | "batched",
  programBytes: ArrayBuffer,
): Promise<number> {
  const stdout = { value: "" };
  const host = new NodeKernelHost({
    onStdout: (_pid, data) => {
      stdout.value += new TextDecoder().decode(data);
    },
  });
  await host.init();
  host.setInputCanvasDims(CANVAS_W, CANVAS_H);

  let pid = 0;
  const exit = host.spawn(
    programBytes,
    ["input-inject-bench", String(RECORDS_PER_WAVE), String(WAVES)],
    { onStarted: (p) => (pid = p) },
  );
  await waitFor(stdout, "ready\n", 10_000);

  const start = performance.now();
  for (let w = 0; w < WAVES; w++) {
    for (let f = 0; f < FRAMES_PER_WAVE; f++) {
      const frame = pointerFrame();
      if (mode === "batched") {
        host.injectInputEventBatch(frame);
      } else {
        for (const r of frame) {
          host.injectInputEvent(r.device, r.ev_type, r.code, r.value);
        }
      }
    }
    await waitFor(stdout, `wave ${w}\n`, 30_000);
  }
  const elapsed = performance.now() - start;

  host.appendStdinData(pid, KICK);
  await Promise.race([exit, new Promise((r) => setTimeout(r, 5_000))]);
  await host.destroy().catch(() => {});
  return elapsed;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  const bin = tryResolveBinary("programs/input-inject-bench.wasm");
  if (!bin) {
    console.error(
      "input-inject-bench.wasm not found — run scripts/build-programs.sh",
    );
    process.exit(1);
  }
  const buf = readFileSync(bin);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  const totalRecords = RECORDS_PER_WAVE * WAVES;
  console.log(
    `input-injection: ${WAVES} waves x ${FRAMES_PER_WAVE} frames ` +
      `(${totalRecords} records), ${ROUNDS} rounds each\n`,
  );

  const results: Record<string, number[]> = { "per-record": [], batched: [] };
  for (let r = 0; r < ROUNDS; r++) {
    for (const mode of ["per-record", "batched"] as const) {
      const ms = await runMode(mode, bytes);
      results[mode].push(ms);
      console.log(`  round ${r} ${mode.padEnd(10)} ${ms.toFixed(1)} ms`);
    }
  }

  const perRecord = median(results["per-record"]);
  const batched = median(results.batched);
  console.log(`\nmedian per-record : ${perRecord.toFixed(1)} ms`);
  console.log(`median batched    : ${batched.toFixed(1)} ms`);
  console.log(
    `speedup           : ${(perRecord / batched).toFixed(2)}x ` +
      `(${(perRecord - batched).toFixed(1)} ms faster over ${totalRecords} records)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
