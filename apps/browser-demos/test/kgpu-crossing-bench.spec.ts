// Measures what the executor-to-renderer crossing costs in each browser
// engine: the real GPU executor module (crates/gpu-executor) handles one
// submission of 10,000 viewport-and-clear pairs against the real WebGL 2
// backend (host/src/kgpu/webgl2-backend.ts) on an OffscreenCanvas, making
// one `kgpu_backend` import call per command, and the spec reports the
// median time per backend call.
//
// WHY a browser spec: the decision it supports (one import per backend
// call; docs/measurements/2026-11-27-kgpu-crossing.md and the design doc's
// Backends section) is about the cost of a Wasm-to-JavaScript import call
// next to the WebGL work it carries, and only a browser engine has both.
// Re-run it before revisiting that decision, for example when the command
// set grows or a backend moves off WebGL 2.
//
// The executor runs on the page's thread rather than in a GPU worker: the
// crossing and the WebGL calls cost the same on either thread, and the bench
// must not include ring or doorbell transport, which is not being measured.
// Each repetition hands the executor the same record and stream, already in
// executor memory, so only `ge_handle` is timed; a read of the surface after
// each repetition (outside the timed window) drains queued GPU work and
// proves the clears happened.
//
// Run: npx playwright test test/kgpu-crossing-bench.spec.ts --project=<engine>
import { test, expect } from '../playwright-test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveBinary } from '../../../host/src/binary-resolver';

const root = resolve(import.meta.dirname, '../../..');
const PAIRS = 10_000;
const WARMUP = 3;
const REPEATS = 20;
let out: string;

test.beforeAll(() => {
    mkdirSync(join(root, '.scratch'), { recursive: true });
    out = mkdtempSync(join(root, '.scratch/kgpu-crossing-'));
    writeFileSync(join(out, 'executor.wasm'), readFileSync(resolveBinary('kandelo_gpu_executor32.wasm')));
    writeFileSync(join(out, 'index.html'), '<!doctype html><title>kgpu crossing bench</title>');
});
test.afterAll(() => { if (out) rmSync(out, { recursive: true, force: true }); });

test('kgpu executor crossing cost per backend call @slow', async ({ page }, info) => {
    test.setTimeout(180000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`/@fs${out}/index.html`);
    const result = await page.evaluate(async ({ root, out, PAIRS, WARMUP, REPEATS }) => {
        const abi = await import(`/@fs${root}/host/src/generated/abi.ts`);
        const { createOffscreenWebgl2, createWebgl2Backend } = await import(`/@fs${root}/host/src/kgpu/webgl2-backend.ts`);
        const { GPU_EXECUTOR_INITIAL_PAGES, GPU_EXECUTOR_MAX_PAGES } = await import(`/@fs${root}/host/src/kgpu/protocol.ts`);
        const F = abi.KGPU_RECORD_FIELDS;
        const CONTEXT = 1;

        // The command stream, in the crates/kgpu-stream wire format. The
        // executor validates every byte, so a format slip fails the
        // completion check below instead of timing a refusal.
        const stream = new Uint8Array(16 + 24 + PAIRS * (24 + 12));
        const s = new DataView(stream.buffer);
        let at = 16;
        const record = (op: number, payload: number) => {
            s.setUint16(at, op, true); s.setUint16(at + 2, 0, true); s.setUint32(at + 4, payload, true);
            at += 8;
        };
        record(2, 16);
        [0.2, 0.4, 0.6, 1.0].forEach((v, i) => s.setFloat32(at + i * 4, v, true));
        at += 16;
        for (let i = 0; i < PAIRS; i++) {
            record(1, 16);
            [0, 0, 4, 4].forEach((v, j) => s.setInt32(at + j * 4, v, true));
            at += 16;
            record(3, 4);
            s.setUint32(at, 0x4000, true);
            at += 4;
        }
        s.setUint32(0, 0x5547_4b4b, true);
        s.setUint16(4, 1, true);
        s.setUint32(8, CONTEXT, true);
        s.setUint32(12, at - 16, true);
        const calls = 1 + 2 * PAIRS;

        const create = new Uint8Array(abi.KGPU_SUBMISSION_HEADER_SIZE);
        const c = new DataView(create.buffer);
        c.setUint32(F.submission.kind, abi.KGPU_SUBMISSION_CONTEXT_CREATE, true);
        c.setUint32(F.submission.context, CONTEXT, true);
        c.setBigUint64(F.submission.seqno, 1n, true);
        const submit = new Uint8Array(abi.KGPU_SUBMISSION_HEADER_SIZE + abi.KGPU_EXTENT_SIZE);
        const u = new DataView(submit.buffer);
        u.setUint32(F.submission.kind, abi.KGPU_SUBMISSION_SUBMIT, true);
        u.setUint32(F.submission.context, CONTEXT, true);
        u.setBigUint64(F.submission.seqno, 2n, true);
        u.setUint32(F.submission.streamExtentCount, 1, true);
        u.setUint32(abi.KGPU_SUBMISSION_HEADER_SIZE + F.extent.len, stream.byteLength, true);

        const expectedPixels = Array.from({ length: 16 }, () => '51,102,153,255').join();
        // Instantiates the executor over its own renderer and returns one
        // timed repetition.
        const instantiate = async (file: string) => {
            const bytes = await fetch(`/@fs${out}/${file}`).then(response => response.arrayBuffer());
            const rendered = createOffscreenWebgl2();
            if (!rendered) throw new Error('no WebGL 2 on OffscreenCanvas');
            const backend = createWebgl2Backend(rendered);
            const memory = new WebAssembly.Memory({ initial: GPU_EXECUTOR_INITIAL_PAGES, maximum: GPU_EXECUTOR_MAX_PAGES });
            const { instance } = await WebAssembly.instantiate(bytes, {
                env: { memory },
                kgpu_backend: {
                    create_surface: (ctx: number, w: number, h: number) => backend.createSurface(ctx >>> 0, w >>> 0, h >>> 0),
                    destroy_surface: (ctx: number) => backend.destroySurface(ctx >>> 0),
                    viewport: (ctx: number, x: number, y: number, w: number, h: number) => backend.viewport(ctx >>> 0, x, y, w, h),
                    clear_color: (ctx: number, r: number, g: number, b: number, a: number) => backend.clearColor(ctx >>> 0, r, g, b, a),
                    clear: (ctx: number, mask: number) => backend.clear(ctx >>> 0, mask >>> 0),
                    read_pixels: () => -abi.ERRNO.EINVAL,
                    is_lost: () => (backend.isLost() ? 1 : 0),
                },
            });
            const e = instance.exports as unknown as {
                ge_alloc(len: number): number;
                ge_handle(record: number, recordLen: number, stream: number, streamLen: number, out: number): number;
            };
            const place = (data: Uint8Array) => {
                const ptr = e.ge_alloc(data.byteLength);
                new Uint8Array(memory.buffer, ptr, data.byteLength).set(data);
                return ptr;
            };
            const createPtr = place(create), submitPtr = place(submit), streamPtr = place(stream);
            const outPtr = e.ge_alloc(abi.KGPU_COMPLETION_SIZE);
            const handle = (ptr: number, len: number, streamLen: number, expected: number) => {
                if (e.ge_handle(ptr, len, streamPtr, streamLen, outPtr) !== abi.KGPU_COMPLETION_SIZE) throw new Error('ge_handle refused');
                const done = new DataView(memory.buffer, outPtr, abi.KGPU_COMPLETION_SIZE);
                const kind = done.getUint32(F.completion.kind, true), status = done.getInt32(F.completion.status, true);
                if (kind !== expected || status !== 0) throw new Error(`completion kind ${kind} status ${status}`);
            };
            handle(createPtr, create.byteLength, 0, abi.KGPU_COMPLETION_CONTEXT_READY);
            const pixels = new Uint8Array(4 * 4 * 4);
            return () => {
                const start = performance.now();
                handle(submitPtr, submit.byteLength, stream.byteLength, abi.KGPU_COMPLETION_RETIRED);
                const elapsed = performance.now() - start;
                pixels.fill(0);
                if (backend.readPixels(CONTEXT, 0, 0, 4, 4, pixels) !== 0) throw new Error('readback failed');
                if (pixels.join() !== expectedPixels) throw new Error(`surface not cleared: ${pixels.slice(0, 4).join()}`);
                return elapsed;
            };
        };
        const run = await instantiate('executor.wasm');
        const samples: number[] = [];
        for (let i = 0; i < WARMUP + REPEATS; i++) {
            const elapsed = run();
            if (i >= WARMUP) samples.push(elapsed);
        }
        const ns = (ms: number) => Math.round(ms * 1e6 / calls);
        const sorted = [...samples].sort((a, b) => a - b);
        const median = (sorted[(sorted.length - 1) >> 1]! + sorted[sorted.length >> 1]!) / 2;
        return {
            userAgent: navigator.userAgent,
            crossOriginIsolated,
            calls,
            medianNsPerCall: ns(median),
            minNsPerCall: ns(sorted[0]!),
            maxNsPerCall: ns(sorted[sorted.length - 1]!),
            samplesMs: samples.map(v => Number(v.toFixed(3))),
        };
    }, { root, out, PAIRS, WARMUP, REPEATS });
    const report = { engine: info.project.name, ...result };
    writeFileSync(info.outputPath('crossing.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`kgpu-crossing ${JSON.stringify(report)}`);
    expect(result.samplesMs).toHaveLength(REPEATS);
    expect(pageErrors).toEqual([]);
});
