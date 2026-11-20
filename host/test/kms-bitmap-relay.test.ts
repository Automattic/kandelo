import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KmsBitmapRelay } from '../src/dri/kms-bitmap-relay';
import { attachKmsBitmapDisplay } from '../src/dri/kms-bitmap-display';
import { createCentralizedKernelWorkerTestDouble } from '../src/kernel-worker';
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function setup() {
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
    const relay = new KmsBitmapRelay(port as unknown as MessagePort, fail, source => createImageBitmap(source));
    relay.changed(0);
    relay.changed(1);
    const canvas = { width: 3072, height: 1728 } as OffscreenCanvas;
    const cursor = { width: 3072, height: 1728 } as OffscreenCanvas;
    const receive = (value: any) => port.onmessage?.({ data: value });
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
let cleanups: (() => Promise<void>)[] = [];
function bitmap() { return { width: 3072, height: 1728, close: vi.fn() } as unknown as ImageBitmap; }
beforeEach(() => vi.useFakeTimers());
afterEach(async () => { const done = cleanups.map(close => close()); await vi.runAllTimersAsync(); await Promise.all(done); cleanups = []; vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('bounded KMS bitmap device ownership and retirement', () => {
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
    it('requires exact ack and captures only a changed plane after publication', async () => {
        const s = setup();
        const images = [bitmap(), bitmap(), bitmap()];
        const create = vi.fn().mockResolvedValueOnce(images[0]).mockResolvedValueOnce(images[1]).mockResolvedValueOnce(images[2]);
        vi.stubGlobal('createImageBitmap', create);
        s.relay.present(s.canvas, s.cursor);
        s.relay.present(s.canvas, s.cursor);
        expect((await s.next()).planes).toEqual([0, 1]);
        expect(create).toHaveBeenCalledTimes(2);
        s.relay.changed(1);
        s.relay.present(s.canvas, s.cursor);
        expect(create).toHaveBeenCalledTimes(2);
        s.ack(1);
        s.relay.present(s.canvas, s.cursor);
        expect((await s.next()).planes).toEqual([1]);
        expect(create).toHaveBeenNthCalledWith(3, s.cursor);
        s.ack(2);
        s.relay.present(s.canvas, s.cursor);
        expect(create).toHaveBeenCalledTimes(3);
        await s.close();
    });
    it('preserves updates arriving while a prior native capture is unresolved', async () => {
        const s = setup();
        const one = deferred<ImageBitmap>(), two = deferred<ImageBitmap>();
        const create = vi.fn().mockReturnValueOnce(one.promise).mockReturnValueOnce(two.promise).mockResolvedValueOnce(bitmap());
        vi.stubGlobal('createImageBitmap', create);
        s.relay.present(s.canvas, s.cursor);
        s.relay.changed(0);
        one.resolve(bitmap());
        two.resolve(bitmap());
        await s.next();
        s.ack(1);
        s.relay.present(s.canvas, s.cursor);
        expect((await s.next()).planes).toEqual([0]);
        s.ack(2);
        await s.close();
    });
    it('awaits late captures, closes them, then fences the display without publishing', async () => {
        const s = setup();
        const one = deferred<ImageBitmap>(), two = deferred<ImageBitmap>();
        vi.stubGlobal('createImageBitmap', vi.fn().mockReturnValueOnce(one.promise).mockReturnValueOnce(two.promise));
        s.relay.present(s.canvas, s.cursor);
        const done = s.relay.close();
        expect(s.relay.close()).toBe(done);
        const a = bitmap(), b = bitmap();
        one.resolve(a);
        expect(s.port.postMessage).not.toHaveBeenCalled();
        two.resolve(b);
        const retire = await s.next();
        expect(retire).toEqual({ type: 'retire', sequence: 0 });
        expect(a.close).toHaveBeenCalledOnce();
        expect(b.close).toHaveBeenCalledOnce();
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
    it.each(['reject', 'throw'])('releases a successful sibling after native capture %s', async (kind) => {
        const s = setup();
        const image = bitmap();
        vi.stubGlobal('createImageBitmap', vi.fn().mockImplementationOnce(() => { if (kind === 'throw')
            throw Error('capture refused'); return Promise.reject(Error('capture refused')); }).mockResolvedValueOnce(image));
        s.relay.present(s.canvas, s.cursor);
        await s.error.promise;
        const done = s.relay.close();
        const rejected = expect(done).rejects.toThrow('capture failed');
        expect(await s.next()).toEqual({ type: 'retire', sequence: 0 });
        expect(image.close).toHaveBeenCalledOnce();
        s.receive({ type: 'retired', sequence: 0 });
        await rejected;
    });
    it('releases both images after frame transfer refusal and preserves the failure', async () => {
        const s = setup();
        const a = bitmap(), b = bitmap();
        vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b));
        const original = s.port.postMessage.getMockImplementation()!;
        s.port.postMessage.mockImplementation((packet, transfer) => { if (packet.type === 'frame')
            throw Error('port refused'); return original(packet, transfer); });
        s.relay.present(s.canvas, s.cursor);
        await s.error.promise;
        const rejected = expect(s.relay.close()).rejects.toThrow('transfer failed');
        expect(await s.next()).toEqual({ type: 'retire', sequence: 0 });
        s.receive({ type: 'retired', sequence: 0 });
        await rejected;
        expect(a.close).toHaveBeenCalledOnce();
        expect(b.close).toHaveBeenCalledOnce();
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
        s.relay.changed(0);
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
        const contexts = [{ transferFromImageBitmap: vi.fn() }, { transferFromImageBitmap: vi.fn() }];
        const canvases = contexts.map(context => ({ width: 1280, height: 720, getContext: () => context }));
        const port = { onmessage: null as ((event: any) => void) | null, onmessageerror: null as (() => void) | null, start: vi.fn(), close: vi.fn(), postMessage: vi.fn() };
        attachKmsBitmapDisplay(canvases as unknown as OffscreenCanvas[], port as unknown as MessagePort);
        return { contexts, canvases, port, send: (data: any) => port.onmessage?.({ data }) };
    }
    it('consumes both planes before acknowledgement, clears both before retirement', () => {
        const s = display(), frames = [new Bitmap(), new Bitmap()];
        s.send({ type: 'frame', sequence: 1, planes: [0, 1], frames });
        expect(s.port.postMessage).toHaveBeenLastCalledWith({ type: 'ack', sequence: 1 });
        for (let i = 0; i < 2; i++) {
            expect(s.contexts[i].transferFromImageBitmap).toHaveBeenCalledWith(frames[i]);
            expect(frames[i].close).toHaveBeenCalledOnce();
            expect(s.canvases[i].width).toBe(3072);
        }
        s.send({ type: 'retire', sequence: 1 });
        expect(s.port.postMessage).toHaveBeenLastCalledWith({ type: 'retired', sequence: 1 });
        for (const context of s.contexts)
            expect(context.transferFromImageBitmap).toHaveBeenLastCalledWith(null);
        expect(s.port.onmessage).toBeNull();
        expect(s.port.close).toHaveBeenCalledOnce();
    });
    it('retires a never-painted display with sequence zero', () => { const s = display(); s.send({ type: 'retire', sequence: 0 }); expect(s.port.postMessage).toHaveBeenCalledWith({ type: 'retired', sequence: 0 }); });
    it('rejects mismatched retirement without acknowledging or dropping the owner', () => { const s = display(); expect(() => s.send({ type: 'retire', sequence: 1 })).toThrow('retirement sequence'); expect(s.port.close).not.toHaveBeenCalled(); expect(s.port.postMessage).not.toHaveBeenCalled(); });
    it.each(['duplicate-plane', 'oversize', 'wrong-sequence'])('releases malformed bundle siblings and never partially displays %s', kind => {
        const s = display(), frames = [new Bitmap(), new Bitmap()];
        if (kind === 'oversize')
            frames[1].width = 3841;
        expect(() => s.send({ type: 'frame', sequence: kind === 'wrong-sequence' ? 2 : 1, planes: kind === 'duplicate-plane' ? [0, 0] : [0, 1], frames })).toThrow('Invalid KMS bitmap');
        for (const context of s.contexts)
            expect(context.transferFromImageBitmap).not.toHaveBeenCalled();
        for (const frame of frames)
            expect(frame.close).toHaveBeenCalledOnce();
        expect(s.port.postMessage).not.toHaveBeenCalled();
    });
    it('releases an unconsumed sibling when native display transfer fails', () => {
        const s = display(), frames = [new Bitmap(), new Bitmap()];
        s.contexts[0].transferFromImageBitmap.mockImplementation(() => { throw Error('display refused'); });
        expect(() => s.send({ type: 'frame', sequence: 1, planes: [0, 1], frames })).toThrow('display refused');
        for (const frame of frames)
            expect(frame.close).toHaveBeenCalledOnce();
        expect(s.port.postMessage).not.toHaveBeenCalled();
    });
});
