import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KmsCursorUpdate } from '../src/dri/cursor-plane';
import { KmsBitmapRelay } from '../src/dri/kms-bitmap-relay';
import { startKmsBitmapDisplay } from '../src/dri/kms-bitmap-display-bootstrap';
import { attachKmsBitmapDisplay } from '../src/dri/kms-bitmap-display';
import { createCentralizedKernelWorkerTestDouble } from '../src/kernel-worker';
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function setup(useDefaultCapture = false, ready = true) {
    const packets: any[] = [];
    const waiters: ((value: any) => void)[] = [];
    const port = { onmessage: null as ((event: any) => void) | null, onmessageerror: null as (() => void) | null,
        start: vi.fn(), close: vi.fn(), postMessage: vi.fn((packet: any, _transfer?: any) => {
            if (waiters.length)
                waiters.shift()!(packet);
            else
                packets.push(packet);
        }) };
    const error = deferred<Error>();
    const fail = vi.fn((value: Error) => error.resolve(value));
    const relay = useDefaultCapture
        ? new KmsBitmapRelay(port as unknown as MessagePort, fail, true)
        : new KmsBitmapRelay(port as unknown as MessagePort, fail, true, source => createImageBitmap(source));
    relay.changed();
    const canvas = { width: 3072, height: 1728 } as OffscreenCanvas;
    const cursor = cursorUpdate();
    const receive = (value: any) => port.onmessage?.({ data: value });
    if (ready) receive({ type: 'ready' });
    const next = () => packets.length ? Promise.resolve(packets.shift()) : new Promise<any>(resolve => waiters.push(resolve));
    async function close() {
        const done = relay.close();
        const packet = await next();
        expect(packet.type).toBe('retire');
        receive({ type: 'retired', sequence: packet.sequence });
        await done;
    }
    cleanups.push(() => relay.close().catch(() => { }));
    return { relay, port, canvas, cursor, fail, error, next, receive, close, ack: (sequence: number) => receive({ type: 'ack', sequence }) };
}
function cursorUpdate(version = 1, x = 20): KmsCursorUpdate {
    return {
        width: 3072, height: 1728, composited: false,
        cursor: { version, x, y: 30, width: 1, height: 1, pixels: new Uint8ClampedArray([120, 19, 61, 255]) },
    };
}
let cleanups: (() => Promise<void>)[] = [];
function bitmap() { return { width: 3072, height: 1728, close: vi.fn() } as unknown as ImageBitmap; }
beforeEach(() => vi.useFakeTimers());
afterEach(async () => { const done = cleanups.map(close => close()); await vi.runAllTimersAsync(); await Promise.all(done); cleanups = []; vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('bounded KMS bitmap device ownership and retirement', () => {
    it('retains dirty planes without native capture until the display is ready', async () => {
        const s = setup(false, false);
        const create = vi.fn().mockResolvedValue(bitmap());
        vi.stubGlobal('createImageBitmap', create);
        s.relay.present(s.canvas, s.cursor);
        s.relay.changed();
        expect(create).not.toHaveBeenCalled();
        expect(s.port.postMessage).not.toHaveBeenCalled();
        s.receive({ type: 'ready' });
        s.relay.present(s.canvas, s.cursor);
        expect(await s.next()).toMatchObject({ frame: expect.anything(), cursor: s.cursor });
        s.ack(1);
        await s.close();
    });
    it('fences a display closed before initialization without capturing it', async () => {
        const s = setup(false, false);
        const create = vi.fn(); vi.stubGlobal('createImageBitmap', create);
        const done = s.relay.close();
        const retire = await s.next();
        expect(retire).toEqual({type: 'retire', sequence: 0});
        s.receive({type: 'ready'});
        s.relay.present(s.canvas);
        expect(create).not.toHaveBeenCalled();
        s.receive({type: 'retired', sequence: 0});
        await done;
        expect(s.fail).not.toHaveBeenCalled();
    });
    it('reports a missing initialization receipt and retains retirement failure', async () => {
        const s = setup(false, false);
        await vi.advanceTimersByTimeAsync(3000);
        expect(await s.error.promise).toBeInstanceOf(Error);
        const rejected = expect(s.relay.close()).rejects.toThrow('did not become ready');
        expect(await s.next()).toEqual({type: 'retire', sequence: 0});
        s.receive({type: 'ready'});
        s.receive({type: 'retired', sequence: 0});
        await rejected;
    });
    it('refuses duplicate initialization without publishing any frame', async () => {
        const s = setup();
        s.receive({type: 'ready'});
        const rejected = expect(s.relay.close()).rejects.toThrow('acknowledgement');
        expect(await s.next()).toEqual({type: 'retire', sequence: 0});
        s.receive({type: 'retired', sequence: 0});
        await rejected;
    });
    it('retains producer pixels when an unchanged frame is presented again', async () => {
        const s = setup(true);
        const source = Object.assign(s.canvas, { pixels: [36, 36, 36], transferToImageBitmap: () => {
            const image = Object.assign(bitmap(), { pixels: [...source.pixels] });
            source.pixels.fill(0);
            return image;
        } });
        vi.stubGlobal('createImageBitmap', vi.fn(() => Object.assign(bitmap(), { pixels: [...source.pixels] })));
        s.relay.present(source);
        const first = await s.next();
        expect(first.frame.pixels).toEqual([36, 36, 36]);
        s.ack(first.sequence);
        // A swap/commit can present a cached frame without redrawing the
        // retained producer canvas. Device capture must preserve those pixels.
        s.relay.changed();
        s.relay.present(source);
        const second = await s.next();
        expect(second.frame.pixels).toEqual([36, 36, 36]);
        expect(source.pixels).toEqual([36, 36, 36]);
        s.ack(second.sequence);
        await s.close();
    });

    it('starts fatal retirement after entry unwind and retains its failed fence for destroy', async () => {
        const pending = deferred<void>();
        const observed = deferred<void>();
        const close = vi.fn(() => pending.promise);
        const fatal = vi.fn(() => { expect(close).toHaveBeenCalledOnce(); observed.resolve(); });
        const diagnostic = vi.fn();
        const worker = createCentralizedKernelWorkerTestDouble({ callbacks: {
            onKernelFatal: fatal, onHostDiagnostic: diagnostic,
        } });
        // Test-owned device; no guest memory or real display is needed to
        // prove the ordering of the fatal latch, retirement, and observer.
        (worker as unknown as { kmsBitmapRelays: Map<number, { close: typeof close }> })
            .kmsBitmapRelays.set(1, { close });
        worker.failPersistenceWriter(new Error('injected kernel failure'));
        expect(close).not.toHaveBeenCalled();
        expect(fatal).not.toHaveBeenCalled();
        vi.runAllTicks();
        await observed.promise;
        expect(close).toHaveBeenCalledOnce();
        expect(fatal).toHaveBeenCalledOnce();
        const destroyFence = worker.closeKmsBitmapRelays();
        const rejected = expect(destroyFence).rejects.toThrow('KMS bitmap retirement failed');
        pending.reject(new Error('injected display retirement failure'));
        await rejected;
        expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            source: 'kms-bitmap-retirement', message: expect.stringContaining('KMS bitmap retirement failed'),
        }));
        await expect(worker.closeKmsBitmapRelays()).rejects.toThrow('KMS bitmap retirement failed');
    });
    it('requires an exact acknowledgement and publishes cursor changes without native capture', async () => {
        const s = setup(), image = bitmap();
        const create = vi.fn().mockResolvedValue(image);
        vi.stubGlobal('createImageBitmap', create);
        s.relay.present(s.canvas, s.cursor);
        expect(await s.next()).toMatchObject({ sequence: 1, frame: image, cursor: s.cursor });

        const moved = cursorUpdate(2, 44);
        s.relay.present(s.canvas, moved);
        expect(s.port.postMessage).toHaveBeenCalledTimes(1);
        s.ack(1);
        s.relay.present(s.canvas, moved);
        expect(await s.next()).toEqual({ type: 'frame', sequence: 2, frame: undefined, cursor: moved });
        expect(s.port.postMessage).toHaveBeenLastCalledWith(expect.anything(), []);
        s.ack(2);
        s.relay.present(s.canvas, moved);
        expect(s.port.postMessage).toHaveBeenCalledTimes(2);

        const composited = { ...moved, width: 1280, height: 720, composited: true };
        s.relay.present(s.canvas, composited);
        expect(await s.next()).toMatchObject({
            sequence: 3, cursor: { ...composited, cursor: { ...moved.cursor, pixels: null } },
        });
        expect(create).toHaveBeenCalledExactlyOnceWith(s.canvas);
        s.ack(3);
        await s.close();
    });
    it('preserves updates arriving while a prior native capture is unresolved', async () => {
        const s = setup(), capture = deferred<ImageBitmap>();
        const first = bitmap(), second = bitmap();
        vi.stubGlobal('createImageBitmap', vi.fn().mockReturnValueOnce(capture.promise).mockResolvedValueOnce(second));
        s.relay.present(s.canvas, s.cursor);
        s.relay.changed();
        const moved = cursorUpdate(2, 44);
        s.relay.present(s.canvas, moved);
        capture.resolve(first);
        expect(await s.next()).toMatchObject({ frame: first, cursor: s.cursor });
        s.ack(1);
        s.relay.present(s.canvas, moved);
        expect(await s.next()).toMatchObject({ frame: second, cursor: moved });
        s.ack(2);
        await s.close();
    });
    it('sends one position while a primary capture is unresolved and fences both in order', async () => {
        const s = setup(), capture = deferred<ImageBitmap>();
        const frame = bitmap();
        vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValueOnce(bitmap()).mockReturnValueOnce(capture.promise));
        s.relay.present(s.canvas, s.cursor);
        s.ack((await s.next()).sequence);

        s.relay.changed();
        s.relay.present(s.canvas, s.cursor);
        const moved = { ...s.cursor, cursor: { ...s.cursor.cursor, version: 2, x: 44 } };
        const latest = { ...moved, cursor: { ...moved.cursor, version: 3, x: 65 } };
        s.relay.present(s.canvas, moved);
        expect(await s.next()).toEqual({ type: 'frame', sequence: 2, position: { version: 2, x: 44, y: 30 } });
        s.relay.present(s.canvas, latest);
        expect(s.port.postMessage).toHaveBeenCalledTimes(2);

        capture.resolve(frame);
        expect(await s.next()).toMatchObject({ sequence: 3, frame, cursor: undefined });
        s.ack(2);
        s.relay.present(s.canvas, latest);
        expect(await s.next()).toEqual({ type: 'frame', sequence: 4, position: { version: 3, x: 65, y: 30 } });

        const done = s.relay.close();
        expect(await s.next()).toEqual({ type: 'retire', sequence: 4 });
        s.ack(3);
        s.ack(4);
        expect(s.port.close).not.toHaveBeenCalled();
        s.receive({ type: 'retired', sequence: 4 });
        await done;
    });
    it('awaits late capture, closes it, then fences the display without publishing', async () => {
        const s = setup(), capture = deferred<ImageBitmap>();
        vi.stubGlobal('createImageBitmap', vi.fn().mockReturnValue(capture.promise));
        s.relay.present(s.canvas, s.cursor);
        const done = s.relay.close();
        expect(s.relay.close()).toBe(done);
        expect(s.port.postMessage).not.toHaveBeenCalled();
        const image = bitmap();
        capture.resolve(image);
        expect(await s.next()).toEqual({ type: 'retire', sequence: 0 });
        expect(image.close).toHaveBeenCalledOnce();
        expect(s.port.close).not.toHaveBeenCalled();
        s.receive({ type: 'retired', sequence: 0 });
        await done;
        expect(s.port.close).toHaveBeenCalledOnce();
    });
    it('awaits both the published frame acknowledgement and the display retirement', async () => {
        const s = setup();
        vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap()));
        s.relay.present(s.canvas);
        await s.next();
        const done = s.relay.close();
        expect(await s.next()).toEqual({ type: 'retire', sequence: 1 });
        s.ack(1);
        expect(s.port.close).not.toHaveBeenCalled();
        s.receive({ type: 'retired', sequence: 1 });
        await done;
        expect(s.port.close).toHaveBeenCalledOnce();
        s.relay.present(s.canvas);
        expect(s.port.postMessage).toHaveBeenCalledTimes(2);
    });
    it.each(['reject', 'throw'])('publishes neither plane after native capture %s', async (kind) => {
        const s = setup();
        vi.stubGlobal('createImageBitmap', vi.fn(() => {
            if (kind === 'throw') throw Error('capture refused');
            return Promise.reject(Error('capture refused'));
        }));
        s.relay.present(s.canvas, s.cursor);
        await s.error.promise;
        const rejected = expect(s.relay.close()).rejects.toThrow('capture failed');
        expect(await s.next()).toEqual({ type: 'retire', sequence: 0 });
        expect(s.port.postMessage).toHaveBeenCalledTimes(1);
        s.receive({ type: 'retired', sequence: 0 });
        await rejected;
    });
    it('releases the image after frame transfer refusal and preserves the failure', async () => {
        const s = setup(), image = bitmap();
        vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(image));
        const original = s.port.postMessage.getMockImplementation()!;
        s.port.postMessage.mockImplementation((packet, transfer) => {
            if (packet.type === 'frame') throw Error('port refused');
            return original(packet, transfer);
        });
        s.relay.present(s.canvas, s.cursor);
        await s.error.promise;
        const rejected = expect(s.relay.close()).rejects.toThrow('transfer failed');
        expect(await s.next()).toEqual({ type: 'retire', sequence: 0 });
        s.receive({ type: 'retired', sequence: 0 });
        await rejected;
        expect(image.close).toHaveBeenCalledOnce();
    });
    it('refuses an acknowledgement before native capture has published the sequence', async () => {
        const s = setup(), capture = deferred<ImageBitmap>();
        vi.stubGlobal('createImageBitmap', vi.fn().mockReturnValue(capture.promise));
        s.relay.present(s.canvas);
        s.ack(1);
        await s.error.promise;
        const rejected = expect(s.relay.close()).rejects.toThrow('acknowledgement');
        const frame = bitmap();
        capture.resolve(frame);
        expect(await s.next()).toEqual({ type: 'retire', sequence: 0 });
        s.receive({ type: 'retired', sequence: 0 });
        await rejected;
        expect(frame.close).toHaveBeenCalledOnce();
    });
    it('refuses a duplicate acknowledgement without admitting another frame', async () => {
        const s = setup();
        vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap()));
        s.relay.present(s.canvas);
        await s.next();
        s.ack(1);
        s.ack(1);
        await s.error.promise;
        const rejected = expect(s.relay.close()).rejects.toThrow('acknowledgement');
        const retire = await s.next();
        s.receive({ type: 'retired', sequence: retire.sequence });
        await rejected;
        s.relay.changed();
        s.relay.present(s.canvas);
        expect(s.port.postMessage).toHaveBeenCalledTimes(2);
    });
    it('refuses an extent beyond the bounded device before native capture', async () => {
        const s = setup();
        const create = vi.fn();
        vi.stubGlobal('createImageBitmap', create);
        s.relay.present({ width: 3841, height: 2160 } as OffscreenCanvas);
        await s.error.promise;
        const rejected = expect(s.relay.close()).rejects.toThrow('extent');
        await s.next();
        s.receive({ type: 'retired', sequence: 0 });
        await rejected;
        expect(create).not.toHaveBeenCalled();
    });
    it('reports missing retirement and still closes a capture resolving after containment', async () => {
        const s = setup(), capture = deferred<ImageBitmap>();
        vi.stubGlobal('createImageBitmap', vi.fn().mockReturnValue(capture.promise));
        s.relay.present(s.canvas);
        const rejected = expect(s.relay.close()).rejects.toThrow('not acknowledged');
        await vi.advanceTimersByTimeAsync(3000);
        await rejected;
        expect(s.fail).toHaveBeenCalledOnce();
        const late = bitmap();
        capture.resolve(late);
        await lateCaptureClosed(late);
        expect(s.port.postMessage).not.toHaveBeenCalled();
        expect(s.port.close).toHaveBeenCalledOnce();
    });
    it.each([{ type: 'retired', sequence: 7 }, { type: 'retired', sequence: 0 }])('does not accept a stale or premature retirement receipt %j', async (receipt) => {
        const s = setup();
        s.receive(receipt);
        await s.error.promise;
        const rejected = expect(s.relay.close()).rejects.toThrow('acknowledgement');
        await s.next();
        s.receive({ type: 'retired', sequence: 0 });
        await rejected;
    });
});
async function lateCaptureClosed(frame: ImageBitmap) {
    // The mock close is itself the completion event, not a guessed microtask count.
    const closed = deferred<void>();
    (frame.close as ReturnType<typeof vi.fn>).mockImplementation(() => closed.resolve());
    await closed.promise;
}
describe('display consumption and exact retirement', () => {
    class Bitmap {
        width = 3072;
        height = 1728;
        close = vi.fn();
    }
    function display() {
        vi.stubGlobal('ImageBitmap', Bitmap);
        vi.stubGlobal('ImageData', class {
            constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
        });
        const primary = { transferFromImageBitmap: vi.fn() };
        const overlay = { putImageData: vi.fn(), clearRect: vi.fn() };
        const cursorEvents = new EventTarget();
        const canvases = [primary, overlay].map(context => ({
            width: 1280, height: 720, getContext: () => context,
            addEventListener: cursorEvents.addEventListener.bind(cursorEvents),
            removeEventListener: cursorEvents.removeEventListener.bind(cursorEvents),
        }));
        const port = { onmessage: null as ((event: any) => void) | null, onmessageerror: null as (() => void) | null, start: vi.fn(), close: vi.fn(), postMessage: vi.fn() };
        attachKmsBitmapDisplay(canvases as unknown as OffscreenCanvas[], port as unknown as MessagePort);
        expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({type: 'ready'});
        port.postMessage.mockClear();
        return { primary, overlay, canvases, port, cursorEvents, send: (data: any) => port.onmessage?.({ data }) };
    }
    it('paints both planes before acknowledgement and clears both before retirement', () => {
        const s = display(), frame = new Bitmap(), cursor = cursorUpdate();
        s.port.postMessage.mockImplementation(({ type }) => {
            if (type === 'ack') {
                expect(s.primary.transferFromImageBitmap).toHaveBeenCalledWith(frame);
                expect(s.overlay.putImageData).toHaveBeenCalledWith(expect.objectContaining({ data: cursor.cursor.pixels }), 20, 30);
            } else {
                expect(s.primary.transferFromImageBitmap).toHaveBeenLastCalledWith(null);
                expect(s.overlay.clearRect).toHaveBeenLastCalledWith(0, 0, 3072, 1728);
            }
        });
        s.send({ type: 'frame', sequence: 1, frame, cursor });
        expect(s.port.postMessage).toHaveBeenLastCalledWith({ type: 'ack', sequence: 1 });
        expect(frame.close).toHaveBeenCalledOnce();
        expect(s.canvases.map(canvas => canvas.width)).toEqual([3072, 3072]);
        s.send({ type: 'retire', sequence: 1 });
        expect(s.port.postMessage).toHaveBeenLastCalledWith({ type: 'retired', sequence: 1 });
        expect(s.port.onmessage).toBeNull();
        expect(s.port.close).toHaveBeenCalledOnce();
        s.cursorEvents.dispatchEvent(new Event('contextrestored'));
        expect(s.overlay.putImageData).toHaveBeenCalledOnce();
    });
    it('updates and restores the cursor without replacing the primary image', () => {
        const s = display(), first = cursorUpdate(), moved = cursorUpdate(2, -3);
        s.send({ type: 'frame', sequence: 1, frame: new Bitmap(), cursor: first });
        s.send({ type: 'frame', sequence: 2, position: { version: 2, x: -3, y: 30 } });
        expect(s.overlay.clearRect).toHaveBeenLastCalledWith(20, 30, 1, 1);
        expect(s.overlay.putImageData).toHaveBeenLastCalledWith(expect.anything(), -3, 30);
        s.cursorEvents.dispatchEvent(new Event('contextrestored'));
        expect(s.overlay.putImageData).toHaveBeenCalledTimes(3);
        expect(s.overlay.putImageData).toHaveBeenLastCalledWith(expect.anything(), -3, 30);
        s.send({ type: 'frame', sequence: 3, cursor: { ...moved, composited: true,
            cursor: { ...moved.cursor, pixels: null } } });
        expect(s.overlay.clearRect).toHaveBeenLastCalledWith(-3, 30, 1, 1);
        expect(s.overlay.putImageData).toHaveBeenCalledTimes(3);
        expect(s.primary.transferFromImageBitmap).toHaveBeenCalledOnce();
        expect(s.port.postMessage).toHaveBeenLastCalledWith({ type: 'ack', sequence: 3 });
    });
    it('rejects a position before its image or with a primary bitmap', () => {
        const s = display(), frame = new Bitmap();
        const position = { version: 2, x: 7, y: 30 };
        expect(() => s.send({ type: 'frame', sequence: 1, position })).toThrow('cursor position');
        s.send({ type: 'frame', sequence: 1, cursor: cursorUpdate() });
        expect(() => s.send({ type: 'frame', sequence: 2, frame, position })).toThrow('cursor position');
        expect(s.primary.transferFromImageBitmap).not.toHaveBeenCalled();
        expect(frame.close).toHaveBeenCalledOnce();
        expect(s.port.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'ack', sequence: 1 });
    });
    it('retires a never-painted display with sequence zero', () => { const s = display(); s.send({ type: 'retire', sequence: 0 }); expect(s.port.postMessage).toHaveBeenCalledWith({ type: 'retired', sequence: 0 }); });
    it('rejects mismatched retirement without acknowledging or dropping the owner', () => { const s = display(); expect(() => s.send({ type: 'retire', sequence: 1 })).toThrow('retirement sequence'); expect(s.port.close).not.toHaveBeenCalled(); expect(s.port.postMessage).not.toHaveBeenCalled(); });
    it.each(['oversize', 'shared-pixels', 'wrong-sequence'])('rejects the whole bundle and closes its bitmap for %s', kind => {
        const s = display(), frame = new Bitmap(), cursor = cursorUpdate();
        if (kind === 'oversize') cursor.width = 3841;
        if (kind === 'shared-pixels') {
            // Malformed inbound message. The trusted producer only sends owned arrays.
            Object.assign(cursor.cursor, { pixels: new Uint8ClampedArray(new SharedArrayBuffer(4)) });
        }
        expect(() => s.send({ type: 'frame', sequence: kind === 'wrong-sequence' ? 2 : 1, frame, cursor })).toThrow(/Invalid KMS (bitmap|cursor)/);
        expect(s.primary.transferFromImageBitmap).not.toHaveBeenCalled();
        expect(s.overlay.putImageData).not.toHaveBeenCalled();
        expect(frame.close).toHaveBeenCalledOnce();
        expect(s.port.postMessage).not.toHaveBeenCalled();
    });
    it('closes the bitmap and leaves the cursor unchanged when native transfer fails', () => {
        const s = display(), frame = new Bitmap();
        s.primary.transferFromImageBitmap.mockImplementation(() => { throw Error('display refused'); });
        expect(() => s.send({ type: 'frame', sequence: 1, frame, cursor: cursorUpdate() })).toThrow('display refused');
        expect(frame.close).toHaveBeenCalledOnce();
        expect(s.overlay.putImageData).not.toHaveBeenCalled();
        expect(s.port.postMessage).not.toHaveBeenCalled();
    });

});


describe('KMS display module bootstrap ownership', () => {
    function setupBootstrap() {
        const ports = [{ close: vi.fn() }, { close: vi.fn() }];
        vi.stubGlobal('MessageChannel', class {
            port1 = ports[0]; port2 = ports[1];
        });
        const worker = { onmessage: null, onerror: null, onmessageerror: null,
            postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker;
        let active = true;
        const attach = vi.fn(), fail = vi.fn();
        const canvases = [{ width: 640, height: 480 }] as OffscreenCanvas[];
        const owned = startKmsBitmapDisplay(worker, canvases, () => active, attach, fail);
        const receive = worker.onmessage!.bind(worker);
        return { worker, attach, fail, owned, ports, canvases,
            deactivate: () => { active = false; },
            loaded: () => receive({ data: { type: 'loaded' } } as MessageEvent) };
    }
    it('does not start the kernel relay while display module loading exceeds its receipt deadline', async () => {
        const s = setupBootstrap();
        await vi.advanceTimersByTimeAsync(5000);
        expect(s.attach).not.toHaveBeenCalled();
        expect(s.worker.postMessage).not.toHaveBeenCalled();
        expect(s.fail).not.toHaveBeenCalled();
        s.loaded();
        expect(s.worker.postMessage).toHaveBeenCalledExactlyOnceWith(
            { canvases: s.canvases, port: s.ports[0] }, [...s.canvases, s.ports[0]]);
        expect(s.attach).toHaveBeenCalledExactlyOnceWith(s.ports[1]);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(s.fail).not.toHaveBeenCalled();
        s.owned.terminate(); s.owned.terminate();
        expect(s.worker.terminate).toHaveBeenCalledOnce();
    });
    it('cancels a pending or queued bootstrap without publishing device authority after shutdown', () => {
        const s = setupBootstrap();
        s.deactivate();
        s.owned.terminate();
        s.loaded();
        expect(s.attach).not.toHaveBeenCalled();
        expect(s.worker.postMessage).not.toHaveBeenCalled();
        expect(s.worker.terminate).toHaveBeenCalledOnce();
        expect(s.ports.every(port => port.close.mock.calls.length === 1)).toBe(true);
        expect(s.fail).not.toHaveBeenCalled();
    });
    it('checks host activity again when module loading completes', () => {
        const s = setupBootstrap(); s.deactivate(); s.loaded();
        expect(s.attach).not.toHaveBeenCalled();
        expect(s.worker.postMessage).not.toHaveBeenCalled();
        expect(s.worker.terminate).toHaveBeenCalledOnce();
        expect(s.fail).not.toHaveBeenCalled();
    });
    it('bounds failed module loading separately and rejects its late receipt', async () => {
        const s = setupBootstrap();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(s.fail).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'KMS bitmap display module did not load' }));
        s.loaded();
        expect(s.attach).not.toHaveBeenCalled();
        expect(s.worker.terminate).toHaveBeenCalledOnce();
    });
});
