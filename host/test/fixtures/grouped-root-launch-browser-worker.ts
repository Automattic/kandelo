import { execute } from './grouped-root-launch-execution';
import { BrowserWorkerAdapter } from '../../src/worker-adapter-browser';
import { VirtualPlatformIO } from '../../src/vfs/vfs';
import { BrowserTimeProvider } from '../../src/vfs/time';
import { installBrowserSetImmediatePolyfill } from '../../src/browser-immediate-polyfill';
installBrowserSetImmediatePolyfill();
self.onmessage = async (event: MessageEvent<{
    stage: string;
}>) => {
    self.onmessage = null;
    try {
        const [kernelBytes, image] = await Promise.all(['/kernel.wasm', '/rootfs.vfs'].map(path => fetch(path).then(r => { if (!r.ok)
            throw Error(path + ':' + r.status); return r.arrayBuffer(); })));
        self.postMessage(await execute({ stage: event.data.stage, kernelBytes, imageBytes: new Uint8Array(image), io: new VirtualPlatformIO([], new BrowserTimeProvider()), adapter: new BrowserWorkerAdapter(new URL('/process.mjs', self.location.href)), joins: false }));
    }
    catch (error) {
        self.postMessage({ failure: String(error), stack: error instanceof Error ? error.stack : undefined });
    }
    finally {
        self.close();
    }
};
