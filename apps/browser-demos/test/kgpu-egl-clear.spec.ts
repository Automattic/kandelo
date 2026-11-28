// The Rust GL driver end to end in each browser engine:
// programs/kgpu-egl-clear.c uses only the Khronos EGL 1.5 and GLES 2.0
// headers and links local-binaries/libkandelo_gl.a (crates/kandelo-gl).
// scripts/build-programs.sh builds it, and the SDK converts it for the
// memory-group backend; it runs under the public BrowserKernel. The
// driver's EGL and GL calls become kgpu command streams, which go through
// the process worker to the kernel's kgpu device, the kernel worker's
// KgpuHost, a real GPU worker running the Rust executor, and the engine's
// own WebGL 2 on an OffscreenCanvas.
//
// WHY a browser spec: host/test/kgpu-host.test.ts proves the same program
// on Node against a WebGL 2 test double. Only a browser has a real
// renderer, so only here do the printed pixels come from an actual GPU
// clear of the driver's 16x8 pbuffer.
import { test, expect } from '../playwright-test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KandeloImageFs } from '../../../images/vfs/lib/kandelo-image-fs';
import { resolveBinary } from '../../../host/src/binary-resolver';
import { buildProgramsFixture, requireBuiltFixtures } from './support/program-fixtures';
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from './support/browser-memory-boundary';

const root = resolve(import.meta.dirname, '../../..');
const program = buildProgramsFixture('programs/wasm32/kgpu-egl-clear.wasm');
// R2: the clear color (0.2, 0.4, 0.6, 1.0) reads back as 51 102 153 255.
const expected = [...[0, 63, 127].map(i => `pixel ${i} 51 102 153 255`), 'egl ok', ''].join('\n');
let out: string;

test.beforeAll(async () => {
    test.setTimeout(180000);
    requireBuiltFixtures([program]);
    // .scratch/ is gitignored, so a fresh checkout may not have it yet.
    mkdirSync(join(root, '.scratch'), { recursive: true });
    out = mkdtempSync(join(root, '.scratch/kgpu-egl-clear-'));
    const grouped = join(out, 'kgpu-egl-clear.grouped.wasm');
    execFileSync(join(root, 'sdk/bin/wasm32posix-shared-memory'), [program, '-o', grouped], { stdio: 'pipe' });
    const image = KandeloImageFs.create(readFileSync(resolveBinary('kandelo_image_module32.wasm')));
    try {
        image.mkdir('/tmp', 0o1777);
        image.mkdir('/bin', 0o755);
        image.writeFile('/bin/kgpu-egl-clear', readFileSync(grouped), 0o755);
        writeFileSync(join(out, 'rootfs.vfs'), await image.saveImage());
    } finally {
        image.reset();
    }
    writeFileSync(join(out, 'kernel.wasm'), readFileSync(resolveBinary('kernel.wasm')));
    writeFileSync(join(out, 'kandelo_gpu_executor32.wasm'), readFileSync(resolveBinary('kandelo_gpu_executor32.wasm')));
    writeFileSync(join(out, 'index.html'), '<!doctype html><title>kgpu EGL clear</title>');
});
test.afterAll(() => { if (out) rmSync(out, { recursive: true, force: true }); });

type Run = { code: number; stdout: string; stderr: string; pinned: number | null };
type Machine = { runs: Run[]; diagnostics: unknown[] };

/** Boot one grouped BrowserKernel in the page and run the program `count`
 * times, in order, returning each run's output and the group's pinned
 * device frames after its exit. */
async function machine(page: import('@playwright/test').Page, count: number): Promise<Machine> {
    return await page.evaluate(async ({ root, out, count }) => {
        const { BrowserKernel } = await import(`/@fs${root}/host/src/browser-kernel-host.ts`);
        const [kernel, image] = await Promise.all(['kernel.wasm', 'rootfs.vfs']
            .map(path => fetch(`/@fs${out}/${path}`).then(response => response.arrayBuffer())));
        let stdout = '', stderr = '';
        const diagnostics: unknown[] = [];
        const host = new BrowserKernel({
            experimentalMemoryGroup: { maximumPages: 512 },
            gpuExecutorUrl: `/@fs${out}/kandelo_gpu_executor32.wasm`,
            onStdout: (bytes: Uint8Array) => { stdout += new TextDecoder().decode(bytes); },
            onStderr: (bytes: Uint8Array) => { stderr += new TextDecoder().decode(bytes); },
            onHostDiagnostic: (event: unknown) => diagnostics.push(event),
        });
        // The usage read answers EAGAIN while the guest allocator is busy.
        const pinned = async (): Promise<number | null> => {
            for (let attempt = 0; ; attempt++) {
                try { return (await host.getMemoryGroupUsage())?.backing?.devicePinnedFrames ?? null; }
                catch (error) {
                    if (attempt >= 100 || !/EAGAIN/.test(String(error))) throw error;
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
            }
        };
        const runs: Run[] = [];
        try {
            await host.initFromOwnedImage({ kernelWasm: kernel, vfsImage: image });
            for (let i = 0; i < count; i++) {
                stdout = ''; stderr = '';
                const path = '/bin/kgpu-egl-clear';
                const child = await host.spawnFromVfs(path, [path], { executionBackend: 'memory-group', stdin: new Uint8Array() });
                const code = await child.exit;
                runs.push({ code, stdout, stderr, pinned: await pinned() });
            }
        } finally {
            await host.destroy();
        }
        return { runs, diagnostics };
    }, { root, out, count });
}

async function open(page: import('@playwright/test').Page): Promise<string[]> {
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await installBrowserMemoryBoundaryProbe(page);
    await page.goto(`/@fs${out}/index.html`);
    return pageErrors;
}

test('egl_clear_reads_back', async ({ page }, info) => {
    test.setTimeout(120000);
    const pageErrors = await open(page);
    const result = await machine(page, 1);
    writeFileSync(info.outputPath('result.json'), JSON.stringify({ engine: info.project.name, result, pageErrors }, null, 2) + '\n');
    const [run] = result.runs;
    expect(run.code, run.stdout).toBe(0);
    expect(run.stdout).toBe(expected);
    expect(run.stderr).toBe('');
    expect(run.pinned).toBe(0);
    expect(result.diagnostics).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(await memoryBoundaryFailures(page)).toEqual([]);
});

// The post-exit invariant only, as in kgpu-clear.spec.ts: after each of 20
// runs exits, no device-pinned frame remains, so the driver's readbacks do
// not leak pins across exits. That pins are held while a readback is in
// flight is proven on Node by `egl_worker_crash_loses_context` in
// host/test/kgpu-host.test.ts.
test('leaves no device-pinned frames after each of 20 runs exits', async ({ page }, info) => {
    test.setTimeout(240000);
    const pageErrors = await open(page);
    const result = await machine(page, 20);
    writeFileSync(info.outputPath('result.json'), JSON.stringify({ engine: info.project.name, result, pageErrors }, null, 2) + '\n');
    expect(result.runs).toHaveLength(20);
    for (const [i, run] of result.runs.entries()) {
        expect(run.code, `run ${i}: ${run.stdout}`).toBe(0);
        expect(run.stdout, `run ${i}`).toBe(expected);
        expect(run.stderr, `run ${i}`).toBe('');
        expect(run.pinned, `run ${i}`).toBe(0);
    }
    expect(result.diagnostics).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(await memoryBoundaryFailures(page)).toEqual([]);
});
