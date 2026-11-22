import { createServer, type Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '../../../../apps/browser-demos/playwright-test';
import { npmInventory, npmTestInputs } from './npm-test-inputs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
let server: Server;
let origin: string;
let inputs: Awaited<ReturnType<typeof npmTestInputs>>;
test.beforeAll(async () => {
    inputs = await npmTestInputs();
    const assets = new Map([['/image.vfs', inputs.image], ['/kernel.wasm', inputs.kernel]]);
    server = createServer((request, response) => {
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        const bytes = assets.get(request.url ?? '');
        if (!bytes) {
            response.writeHead(404);
            response.end();
            return;
        }
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
        response.end(bytes);
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string')
        throw Error('Missing fixture server address');
    origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
    if (server)
        await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeAllConnections();
        });
});
// This exercises the normal installed archive through BrowserKernel. The actual
// app's terminal/REPL checks remain a distinct UI test, using its persistent
// fixture. A controlled guest registry is not a public Internet test.
test('installed npm preserves offline and controlled-registry behavior', async ({ page, baseURL, browserName, browser }, testInfo) => {
    test.setTimeout(npmInventory.limitsMs.outerRunner);
    const receipt: any = { host: browserName, hostVersion: browser.version(),
        identities: inputs.identities, automaticRetries: 0, pageErrors: [], pageCrashes: [] };
    page.on('pageerror', error => receipt.pageErrors.push(error.message));
    page.on('crash', () => receipt.pageCrashes.push(new Date().toISOString()));
    // Persist each real invocation before the next begins, including failures.
    await page.exposeFunction('__npmCheckpoint', (result: any) => { receipt.result = result; });
    try {
        await page.goto(new URL('/pages/test-runner/?minimal=1', baseURL).href);
        receipt.result = await page.evaluate(async ({ runnerUrl, kernelModuleUrl, lazyAssetsModuleUrl, origin, inventory }) => {
            const [{ runNpmCases }, { BrowserKernel }, { imageOwnedLazyAssetDirectory }] = await Promise.all([
                import(/* @vite-ignore */ runnerUrl), import(/* @vite-ignore */ kernelModuleUrl),
                import(/* @vite-ignore */ lazyAssetsModuleUrl),
            ]);
            const readinessStartedAt = performance.now();
            let timer: ReturnType<typeof setTimeout>;
            const [image, kernel] = await (async () => {
                try {
                    return await Promise.race([
                        (async () => {
                            const responses = await Promise.all([fetch(origin + '/image.vfs'), fetch(origin + '/kernel.wasm')]);
                            if (!responses.every(response => response.ok))
                                throw Error('Could not load exact npm test artifacts');
                            return Promise.all(responses.map(response => response.arrayBuffer()));
                        })(),
                        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Artifact readiness exceeded finite budget; nonpassing; no retry')), inventory.limitsMs.readiness); }),
                    ]);
                }
                finally {
                    clearTimeout(timer!);
                }
            })();
            return runNpmCases(new Uint8Array(image), new Uint8Array(kernel), inventory, (options: any) => {
                const browser = new BrowserKernel({ kernelOwnedFs: true,
                    onProcessStdout: options.onStdout, onProcessStderr: options.onStderr,
                    onHostDiagnostic: options.onHostDiagnostic, onProcessEvent: options.onProcessEvent,
                    onProcessGenerationEvent: options.onProcessGenerationEvent,
                });
                return {
                    init: (kernelWasm: ArrayBuffer) => browser.initFromImage({
                        vfsImage: options.rootfsImage, kernelWasm,
                        lazyAssetDirectory: imageOwnedLazyAssetDirectory(),
                    }),
                    spawnFromVfs: browser.spawnFromVfs.bind(browser),
                    subscribeDestroyProgress: browser.subscribeDestroyProgress.bind(browser),
                    enumProcs: browser.enumProcs.bind(browser), readDirFromVfs: browser.readDirFromVfs.bind(browser),
                    readFileFromVfs: browser.readFileFromVfs.bind(browser), destroy: browser.destroy.bind(browser),
                };
            }, (result: any) => { (globalThis as any).__npmCheckpoint(result); }, readinessStartedAt);
        }, {
            runnerUrl: new URL(`/@fs/${resolve(root, 'packages/registry/node-browser-bundle/test/npm-consumer.ts')}`, baseURL).href,
            kernelModuleUrl: new URL(`/@fs/${resolve(root, 'host/src/browser-kernel-host.ts')}`, baseURL).href,
            lazyAssetsModuleUrl: new URL(`/@fs/${resolve(root, 'apps/browser-demos/lib/init/image-owned-runtime-urls.ts')}`, baseURL).href,
            origin, inventory: npmInventory,
        });
        expect(receipt.result.unrun).toEqual([]);
        expect(receipt.result.cases.map((row: any) => row.id)).toEqual(npmInventory.cases.map((row: any) => row.id));
        expect(receipt.result.cases).toHaveLength(10);
        expect(receipt.result.passed, JSON.stringify(receipt.result)).toBe(true);
        expect(receipt.pageErrors).toEqual([]);
        expect(receipt.pageCrashes).toEqual([]);
        receipt.passed = true;
    }
    catch (error) {
        receipt.error = String(error);
        receipt.passed = false;
        throw error;
    }
    finally {
        await testInfo.attach('npm-regression-receipt', {
            body: JSON.stringify(receipt, null, 2), contentType: 'application/json',
        });
    }
});
