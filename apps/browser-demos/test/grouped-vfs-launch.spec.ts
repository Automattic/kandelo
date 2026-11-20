import { test, expect } from '../playwright-test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { KandeloImageFs } from '../../../images/vfs/lib/kandelo-image-fs';
import { compileSdkFixture } from '../../../host/test/support/compile-sdk-fixture';
import { resolveBinary } from '../../../host/src/binary-resolver';
const root = resolve(import.meta.dirname, '../../..');
let out: string;
const inputs: Record<string, string> = {};
const fixtures: ReturnType<typeof compileSdkFixture>[] = [];
test.beforeAll(async () => {
    test.setTimeout(180000);
    out = mkdtempSync(join(root, '.scratch/grouped-vfs-launch-'));
    const image = KandeloImageFs.create();
    try {
        image.mkdir('/tmp', 0o1777);
        image.mkdir('/bin', 0o755);
        for (const name of ['fork', 'pthread', 'executable-identity', 'dri-mapping-fork', 'dri-direct']) {
            const fixture = compileSdkFixture(new URL(`../../../host/test/fixtures/${name === 'dri-mapping-fork' ? 'dri-mapping-fork.c' : `grouped-sdk-${name}.c`}`, import.meta.url), [], { forkInstrument: true });
            fixtures.push(fixture);
            const grouped = fixture.programPath + '.grouped.wasm';
            execFileSync(join(root, 'sdk/bin/wasm32posix-shared-memory'), [fixture.programPath, '-o', grouped], { stdio: 'pipe' });
            for (const [arm, path] of [['ordinary', fixture.programPath], ['grouped', grouped]]) {
                const bytes = readFileSync(path);
                image.writeFile(`/bin/${name}-${arm}`, bytes, 0o755);
                inputs[`${name}-${arm}`] = createHash('sha256').update(bytes).digest('hex');
            }
        }
        image.writeFile('/bin/denied', readFileSync(fixtures[0].programPath + '.grouped.wasm'), 0o644);
        const imageBytes = await image.saveImage();
        const kernel = readFileSync(resolveBinary('kernel.wasm'));
        inputs.image = createHash('sha256').update(imageBytes).digest('hex');
        inputs.kernel = createHash('sha256').update(kernel).digest('hex');
        writeFileSync(join(out, 'rootfs.vfs'), imageBytes);
        writeFileSync(join(out, 'kernel.wasm'), kernel);
        writeFileSync(join(out, 'index.html'), '<!doctype html><title>Normal VFS group launch</title>');
    }
    finally {
        image.reset();
    }
});
test.afterAll(() => {
    for (const fixture of fixtures)
        fixture.cleanup();
    if (out)
        rmSync(out, { recursive: true, force: true });
});
for (const enabled of [false, true])
    test(`normal VFS root and executable identity opt-in=${enabled}`, async ({ page }, info) => {
        test.setTimeout(120000);
        const pageErrors: string[] = [];
        page.on('pageerror', e => pageErrors.push(e.message));
        await page.goto(`/@fs${out}/index.html`);
        const result = await page.evaluate(async ({ enabled, root, out }) => {
            const { BrowserKernel } = await import(`/@fs${root}/host/src/browser-kernel-host.ts`);
            let stdout = '', stderr = '';
            const diagnostics: unknown[] = [];
            const exits: unknown[] = [];
            const rejected: unknown[] = [];
            const host = new BrowserKernel({ maxWorkers: 16, maxMemoryPages: 2048, kernelMaxPages: 1024,
                experimentalMemoryGroup: enabled ? { maximumPages: 2048, maximumProcesses: 8, maximumTasks: 16 } : undefined,
                onStdout: (b: Uint8Array) => stdout += new TextDecoder().decode(b),
                onStderr: (b: Uint8Array) => stderr += new TextDecoder().decode(b),
                onHostDiagnostic: (e: unknown) => diagnostics.push(e) });
            try {
                const base = `/@fs${out}/`;
                const [kernel, image] = await Promise.all([fetch(base + 'kernel.wasm').then(r => r.arrayBuffer()), fetch(base + 'rootfs.vfs').then(r => r.arrayBuffer())]);
                await host.initFromOwnedImage({ kernelWasm: kernel, vfsImage: image });
                for (let round = 0; round < 3; round++) {
                    try {
                        await host.spawnFromVfs('/bin/denied', ['/bin/denied', 'grouped'], { stdin: new Uint8Array() });
                        throw Error('non-executable program ran');
                    }
                    catch (e) {
                        const text = String(e);
                        if (!text.includes('errno 13'))
                            throw e;
                        rejected.push({ kind: 'permission', round });
                    }
                    for (const name of ['fork', 'pthread', 'executable-identity'])
                        for (const arm of ['ordinary', 'grouped']) {
                            const path = `/bin/${name}-${arm}`, args = name === 'executable-identity' ? [path, path] : [path, arm];
                            if (!enabled && arm === 'grouped') {
                                try {
                                    await host.spawnFromVfs(path, args, { stdin: new Uint8Array() });
                                    throw Error('grouped binary ran without opt-in');
                                }
                                catch (e) {
                                    if (!String(e).includes('errno 8'))
                                        throw e;
                                    rejected.push({ kind: 'opt-in', name, round });
                                }
                                continue;
                            }
                            const child = await host.spawnFromVfs(path, args, { stdin: new Uint8Array(), env: ['PATH=/bin'] });
                            const code = await child.exit;
                            if (code !== 0)
                                throw Error(JSON.stringify({ path, code, stdout, stderr, diagnostics }));
                            const record = await host.readFileFromVfs(`/proc/${child.pid}/stat`);
                            if (arm === 'grouped' && record !== null)
                                throw Error('completed grouped root record retained');
                            exits.push({ path, code, pid: child.pid });
                        }
                }
                return { stdout, stderr, diagnostics, exits, rejected };
            }
            finally {
                await host.destroy();
            }
        }, { enabled, root, out });
        writeFileSync(info.outputPath('result.json'), JSON.stringify({ engine: info.project.name, enabled, inputs, result, pageErrors }, null, 2) + '\n');
        expect(result.exits).toHaveLength(enabled ? 18 : 9);
        expect(result.rejected).toHaveLength(enabled ? 3 : 12);
        expect(result.stdout).toContain('grouped-sdk-fork PASS');
        expect(result.stdout).toContain('grouped-sdk-pthread PASS');
        expect(result.stdout).toContain('grouped-sdk-executable-identity PASS');
        expect(result.stderr).toBe('');
        expect(result.diagnostics).toEqual([]);
        expect(pageErrors).toEqual([]);
    });

test('rolls back initial grouped allocation refusals and preserves ordinary execution', async ({ page }, info) => {
    test.setTimeout(120000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`/@fs${out}/index.html`);
    const result = await page.evaluate(async ({ root, out }) => {
        const { BrowserKernel } = await import(`/@fs${root}/host/src/browser-kernel-host.ts`);
        let stdout = '', stderr = '';
        const diagnostics: unknown[] = [];
        let refused = 0;
        const host = new BrowserKernel({ maxWorkers: 16, maxMemoryPages: 2048, kernelMaxPages: 1024,
            experimentalMemoryGroup: { maximumPages: 2, maximumProcesses: 1, maximumTasks: 1 },
            onStdout: (bytes: Uint8Array) => { stdout += new TextDecoder().decode(bytes); },
            onStderr: (bytes: Uint8Array) => { stderr += new TextDecoder().decode(bytes); },
            onHostDiagnostic: (event: unknown) => diagnostics.push(event) });
        try {
            const base = `/@fs${out}/`;
            const [kernel, image] = await Promise.all(['kernel.wasm', 'rootfs.vfs']
                .map(path => fetch(base + path).then(response => response.arrayBuffer())));
            await host.initFromOwnedImage({ kernelWasm: kernel, vfsImage: image });
            for (let attempt = 0; attempt < 16; attempt++) {
                try {
                    await host.spawnFromVfs('/bin/fork-grouped', ['grouped', 'grouped'], { stdin: new Uint8Array() });
                    throw Error('grouped image unexpectedly fit');
                } catch (error) {
                    if (!String(error).includes('Grouped root image: errno 12')) throw error;
                    refused++;
                }
                const live = (await host.enumProcs()).filter((process: { pid: number }) => process.pid !== 1);
                if (live.length) throw Error('failed grouped root retained: ' + JSON.stringify(live));
            }
            const child = await host.spawnFromVfs('/bin/fork-ordinary', ['ordinary', 'ordinary'], { stdin: new Uint8Array() });
            const code = await child.exit;
            return { refused, code, stdout, stderr, diagnostics };
        } finally { await host.destroy(); }
    }, { root, out });
    writeFileSync(info.outputPath('result.json'), JSON.stringify({ engine: info.project.name, inputs, result, pageErrors }, null, 2) + '\n');
    expect(result.refused).toBe(16);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('grouped-sdk-fork PASS');
    expect(result.stderr).toBe('');
    expect(result.diagnostics).toEqual([]);
    expect(pageErrors).toEqual([]);
});


test('runs public browser DRM fork and direct-alias controls through normal VFS launch', async ({page}, info) => {
    test.setTimeout(120000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`/@fs${out}/index.html`);
    const result = await page.evaluate(async ({root, out}) => {
        const {BrowserKernel} = await import(`/@fs${root}/host/src/browser-kernel-host.ts`);
        let stdout = '', stderr = ''; const diagnostics: unknown[] = [], rows: any[] = [];
        const host = new BrowserKernel({maxWorkers: 16, maxMemoryPages: 2048, kernelMaxPages: 1024,
            experimentalMemoryGroup: {maximumPages: 2048, maximumProcesses: 8, maximumTasks: 16},
            onStdout: (bytes: Uint8Array) => { stdout += new TextDecoder().decode(bytes); },
            onStderr: (bytes: Uint8Array) => { stderr += new TextDecoder().decode(bytes); },
            onHostDiagnostic: (event: unknown) => diagnostics.push(event)});
        try {
            const base = `/@fs${out}/`;
            const [kernel, image] = await Promise.all(['kernel.wasm', 'rootfs.vfs']
                .map(path => fetch(base + path).then(response => response.arrayBuffer())));
            await host.initFromOwnedImage({kernelWasm: kernel, vfsImage: image});
            for (const probe of ['dri-mapping-fork', 'dri-direct']) for (const arm of ['ordinary', 'grouped']) {
                const path = `/bin/${probe}-${arm}`, beforeOut = stdout.length, beforeErr = stderr.length;
                const child = await host.spawnFromVfs(path, [path], {stdin: new Uint8Array(), env: ['PATH=/bin']});
                const code = await child.exit;
                const row = {probe, arm, code, stdout: stdout.slice(beforeOut), stderr: stderr.slice(beforeErr)};
                rows.push(row);
                const expected = probe === 'dri-direct' && arm === 'ordinary' ? 23 : 0;
                if (code !== expected) throw Error(JSON.stringify({rows, diagnostics}));
                if (arm === 'grouped' && await host.readFileFromVfs(`/proc/${child.pid}/stat`) !== null)
                    throw Error('Grouped DRM root retained after exit');
            }
            return {rows, diagnostics};
        } finally {await host.destroy();}
    }, {root, out});
    writeFileSync(info.outputPath('result.json'), JSON.stringify({engine: info.project.name, inputs, result, pageErrors}, null, 2) + '\n');
    expect(result.rows.map(row => [row.probe, row.arm, row.code])).toEqual([
        ['dri-mapping-fork', 'ordinary', 0], ['dri-mapping-fork', 'grouped', 0],
        ['dri-direct', 'ordinary', 23], ['dri-direct', 'grouped', 0],
    ]);
    for (const row of result.rows) {
        expect(row.stderr).toBe(row.code === 23 ? 'DIRECT-ALIAS-UNAVAILABLE\n' : '');
        if (row.probe === 'dri-mapping-fork') expect(row.stdout).toContain('OK fixed PRIME replacement preserves alias storage across fork');
        else if (row.arm === 'grouped') expect(row.stdout).toContain('grouped-sdk-dri-direct PASS');
    }
    expect(result.diagnostics).toEqual([]);
    expect(pageErrors).toEqual([]);
});
