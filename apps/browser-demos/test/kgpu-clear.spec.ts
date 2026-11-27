// The kgpu path end to end in each browser engine: programs/kgpu-clear.c,
// built by scripts/build-programs.sh and converted for the memory-group
// backend by the SDK, runs under the public BrowserKernel. Its
// kandelo.kgpu.v1 calls go through the process worker to the kernel's kgpu
// device, the kernel worker's KgpuHost, a real GPU worker running the Rust
// executor, and the engine's own WebGL 2 on an OffscreenCanvas; the pixels
// it prints are what that renderer read back.
//
// WHY a browser spec: host/test/kgpu-host.test.ts proves the same path on
// Node against a WebGL 2 test double. Only a browser has a real renderer,
// so only here do the printed pixels come from an actual GPU clear.
import { test, expect } from '../playwright-test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KandeloImageFs } from '../../../images/vfs/lib/kandelo-image-fs';
import { resolveBinary } from '../../../host/src/binary-resolver';
import { buildProgramsFixture, requireBuiltFixtures } from './support/program-fixtures';
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from './support/browser-memory-boundary';

const root = resolve(import.meta.dirname, '../../..');
const program = buildProgramsFixture('programs/wasm32/kgpu-clear.wasm');
// R2: the clear color (0.2, 0.4, 0.6, 1.0) reads back as 51 102 153 255.
const clearedPixels = Array.from({ length: 16 }, (_, i) => `pixel ${i} 51 102 153 255`);
let out: string;

test.beforeAll(async () => {
    test.setTimeout(180000);
    requireBuiltFixtures([program]);
    out = mkdtempSync(join(root, '.scratch/kgpu-clear-'));
    const grouped = join(out, 'kgpu-clear.grouped.wasm');
    execFileSync(join(root, 'sdk/bin/wasm32posix-shared-memory'), [program, '-o', grouped], { stdio: 'pipe' });
    const image = KandeloImageFs.create(readFileSync(resolveBinary('kandelo_image_module32.wasm')));
    try {
        image.mkdir('/tmp', 0o1777);
        image.mkdir('/bin', 0o755);
        image.writeFile('/bin/kgpu-clear', readFileSync(grouped), 0o755);
        // The same program as build-programs.sh linked it, for the ordinary
        // (ungrouped) backend.
        image.writeFile('/bin/kgpu-clear-ordinary', readFileSync(program), 0o755);
        writeFileSync(join(out, 'rootfs.vfs'), await image.saveImage());
    } finally {
        image.reset();
    }
    writeFileSync(join(out, 'kernel.wasm'), readFileSync(resolveBinary('kernel.wasm')));
    writeFileSync(join(out, 'kandelo_gpu_executor32.wasm'), readFileSync(resolveBinary('kandelo_gpu_executor32.wasm')));
    writeFileSync(join(out, 'index.html'), '<!doctype html><title>kgpu clear</title>');
});
test.afterAll(() => { if (out) rmSync(out, { recursive: true, force: true }); });

type Run = { arm: string; code: number; stdout: string; stderr: string; pinned: number | null };
type Machine = { runs: Run[]; diagnostics: unknown[] };

/** Boot one BrowserKernel in the page and run each arm's program once, in
 * order, returning each run's output and the group's pinned device frames
 * after its exit (null while the machine has no group backing). */
async function machine(page: import('@playwright/test').Page, arms: Array<{ path: string; backend: 'ordinary' | 'memory-group' }>,
    options: { grouped: boolean }): Promise<Machine> {
    return await page.evaluate(async ({ root, out, arms, grouped }) => {
        const { BrowserKernel } = await import(`/@fs${root}/host/src/browser-kernel-host.ts`);
        const [kernel, image] = await Promise.all(['kernel.wasm', 'rootfs.vfs']
            .map(path => fetch(`/@fs${out}/${path}`).then(response => response.arrayBuffer())));
        let stdout = '', stderr = '';
        const diagnostics: unknown[] = [];
        const host = new BrowserKernel({
            ...(grouped ? { experimentalMemoryGroup: { maximumPages: 512 } } : {}),
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
            for (const { path, backend } of arms) {
                stdout = ''; stderr = '';
                const child = await host.spawnFromVfs(path, [path], { executionBackend: backend, stdin: new Uint8Array() });
                const code = await child.exit;
                runs.push({ arm: `${path} ${backend}`, code, stdout, stderr, pinned: await pinned() });
            }
        } finally {
            await host.destroy();
        }
        return { runs, diagnostics };
    }, { root, out, arms, grouped: options.grouped });
}

const pixelLines = (stdout: string) => stdout.split('\n').filter(line => line.startsWith('pixel '));

async function open(page: import('@playwright/test').Page): Promise<string[]> {
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await installBrowserMemoryBoundaryProbe(page);
    await page.goto(`/@fs${out}/index.html`);
    return pageErrors;
}

test('clears and reads back through the GPU worker', async ({ page }, info) => {
    test.setTimeout(120000);
    const pageErrors = await open(page);
    const result = await machine(page, [{ path: '/bin/kgpu-clear', backend: 'memory-group' }], { grouped: true });
    writeFileSync(info.outputPath('result.json'), JSON.stringify({ engine: info.project.name, result, pageErrors }, null, 2) + '\n');
    const [run] = result.runs;
    expect(run.code, run.stdout).toBe(0);
    expect(pixelLines(run.stdout)).toEqual(clearedPixels);
    expect(run.stderr).toBe('');
    expect(run.pinned).toBe(0);
    expect(result.diagnostics).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(await memoryBoundaryFailures(page)).toEqual([]);
});

// The ordinary backend admits a program that imports kandelo.kgpu.v1 (the
// import is an implemented extension), and the kernel refuses each kgpu op
// from a task outside a memory group with EOPNOTSUPP. Both machines with
// and without a configured group behave the same way.
test('refuses kgpu outside a memory group with EOPNOTSUPP', async ({ page }, info) => {
    test.setTimeout(120000);
    const pageErrors = await open(page);
    const configured = await machine(page, [{ path: '/bin/kgpu-clear-ordinary', backend: 'ordinary' }], { grouped: true });
    const plain = await machine(page, [{ path: '/bin/kgpu-clear-ordinary', backend: 'ordinary' }], { grouped: false });
    writeFileSync(info.outputPath('result.json'), JSON.stringify({ engine: info.project.name, configured, plain, pageErrors }, null, 2) + '\n');
    for (const result of [configured, plain]) {
        const [run] = result.runs;
        expect(run.stdout).toBe('kgpu-clear: context create failed: -95 EOPNOTSUPP\n');
        expect(run.code).toBe(1);
        expect(run.stderr).toBe('');
        // Nothing ran grouped, so no group backing exists to pin.
        expect(run.pinned).toBeNull();
        expect(result.diagnostics).toEqual([]);
    }
    expect(pageErrors).toEqual([]);
    expect(await memoryBoundaryFailures(page)).toEqual([]);
});

test('releases every pinned frame across repeated runs', async ({ page }, info) => {
    test.setTimeout(240000);
    const pageErrors = await open(page);
    const result = await machine(page, Array.from({ length: 20 }, () => ({ path: '/bin/kgpu-clear', backend: 'memory-group' as const })),
        { grouped: true });
    writeFileSync(info.outputPath('result.json'), JSON.stringify({ engine: info.project.name, result, pageErrors }, null, 2) + '\n');
    expect(result.runs).toHaveLength(20);
    for (const [i, run] of result.runs.entries()) {
        expect(run.code, `run ${i}: ${run.stdout}`).toBe(0);
        expect(pixelLines(run.stdout), `run ${i}`).toEqual(clearedPixels);
        expect(run.stderr, `run ${i}`).toBe('');
        expect(run.pinned, `run ${i}`).toBe(0);
    }
    expect(result.diagnostics).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(await memoryBoundaryFailures(page)).toEqual([]);
});
