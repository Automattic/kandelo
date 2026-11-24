import { test, expect } from '../playwright-test';
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveBinary } from '../../../host/src/binary-resolver';
import { resolve } from 'node:path';
import { groupedRootLaunchFixture } from '../../../host/test/support/grouped-root-launch-fixture';
const root = resolve(import.meta.dirname, '../../..');
let server: Server, url: string;
test.beforeAll(async () => {
    test.setTimeout(180000);
    const routes = new Map<string, Uint8Array>([['/kernel.wasm', readFileSync(resolveBinary('kernel.wasm'))], ['/rootfs.vfs', await groupedRootLaunchFixture()]]);
    for (const [route, file] of [['/kernel.mjs', 'host/test/fixtures/grouped-root-launch-browser-worker.ts'], ['/process.mjs', 'host/src/worker-entry-browser.ts']]) {
        const result = await build({ entryPoints: [resolve(root, file)], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
        routes.set(route, result.outputFiles[0].contents);
    }
    server = createServer((req, res) => { res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><title>Grouped root custody</title>');
    }
    else if (routes.has(req.url!)) {
        res.setHeader('Content-Type', req.url!.endsWith('.mjs') ? 'text/javascript' : 'application/wasm');
        res.end(routes.get(req.url!));
    }
    else {
        res.statusCode = 404;
        res.end();
    } });
    await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
    const address = server.address();
    if (!address || typeof address === 'string')
        throw Error('server missing address');
    url = `http://127.0.0.1:${address.port}/`;
});
test.afterAll(async () => { if (server)
    await new Promise<void>(yes => { server.close(() => yes()); server.closeAllConnections(); }); });
for (const stage of ['registration-before', 'registration-after', 'constructor', 'stopped-constructor', 'readiness', 'launch-message', 'stopped-destroy', 'destroy-in-registration'])
    test(stage, async ({ page, browser }, info) => {
        test.setTimeout(90000);
        const pageErrors: string[] = [];
        page.on('pageerror', e => pageErrors.push(e.message));
        await page.goto(url);
        const r: any = await page.evaluate(stage => new Promise((yes, no) => { const worker = new Worker('/kernel.mjs', { type: 'module' }); const timer = setTimeout(() => { worker.terminate(); no(Error('kernel Worker deadline')); }, 75000); worker.onmessage = e => { clearTimeout(timer); worker.terminate(); yes(e.data); }; worker.onerror = e => { clearTimeout(timer); worker.terminate(); no(Error(e.message)); }; worker.postMessage({ stage }); }), stage);
        writeFileSync(info.outputPath('result.json'), JSON.stringify({ stage, browser: browser.version(), result: r, pageErrors }, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
        expect(pageErrors).toEqual([]);
        if (['constructor', 'stopped-constructor', 'readiness', 'launch-message'].includes(stage)) {
            expect(r.fatal).toBe('Grouped process launch failed; storage retained');
            expect(r.constructionAttempts).toBe(1);
            expect(r.fatalLedger.kernel).toMatchObject({ processes: 1, images: 1, tasks: 1 });
            expect(r.fatalLedgerObserved).toBe('before-fatal-latch');
            expect(r.inspectionRefusal).toBe('Error: Grouped process launch failed; storage retained');
            return;
        }
        expect(r.failure, JSON.stringify(r)).toBeUndefined();
        expect(r.diagnostics).toEqual([]);
        expect(r.stderr).toBe('');
        expect(r.kernel).toMatchObject({ processes: 0, images: 0, tasks: 0 });
        expect(r.backing).toMatchObject({ allocatedPages: 1, images: 0, replicas: 0 });
        expect(r.rootReceipt).toBe(-3);
        if (stage.startsWith('registration-')) {
            expect(r.injected).toBe(16);
            expect(r.code).toBe(0);
            expect(r.stdout).toContain('grouped-sdk-fork PASS');
            for (const row of r.rollbacks) {
                expect(row.kernel).toMatchObject({ processes: 0, images: 0, tasks: 0 });
                expect(row.backing).toMatchObject({ allocatedPages: 1, images: 0, replicas: 0 });
                expect(row.receipt).toBe(-3);
            }
        }
        else {
            expect(r.code).toBe(137);
            if (stage === 'stopped-destroy')
                expect(r.constructionAttempts).toBe(0);
        }
    });
