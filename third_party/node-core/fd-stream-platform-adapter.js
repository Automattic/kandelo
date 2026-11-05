// FD transport beneath the shared stream state machines. These owners borrow
// process stdio descriptors; a stream transition must never close/reuse them.
// Exact public Socket/TTY/file subclasses remain separate integration work.
function _createNodeFdStreamPlatform(platform) {
    'use strict';
    const P = _createNodePrimordials();
    const { PromisePrototypeThen, ReflectApply, TypedArrayPrototypeGetLength, Uint8Array } = P;
    const Buffer = platform.Buffer, bufferFrom = Buffer.from;
    const { Readable, Writable } = platform.stream;
    const process = platform.process;
    /* NODE_STDIO_DUMMY_DESTROY */

    function writable(fd, options) {
        // The native operation owns copied bytes through all partial writes
        // and readiness waits. Writable owns serialization, HWM, drain,
        // encoding, callback-once and end/final/error state above that seam.
        const result = new Writable({
            ...options,
            write(chunk, encoding, callback) {
                let promise;
                try { promise = platform.native.__kandeloFdWrite(fd, chunk); }
                catch (error) { callback(error); return; }
                PromisePrototypeThen(promise, () => callback(), error => callback(error));
            },
        });
        result.fd = fd;
        result._isStdio = true;
        result.destroySoon = result.destroy;
        // Match the target process-specific destroy policy: close is observable
        // but fd 1/2 remain open and the JS stream can be used again.
        result._destroy = dummyDestroy;
        return result;
    }

    function readable(fd, options) {
        let pending = null, requested = false, stopped = false;
        let referenced = true, ended = false, retired = false;
        function start() {
            if (pending || !requested || stopped || ended || retired) return;
            requested = false;
            let request;
            try {
                request = { promise: platform.native.__kandeloFdRead(fd, 4096, true), cancelled: false };
                pending = request;
                if (!referenced) platform.native.__kandeloFdReadControl(request.promise, false);
            } catch (error) { pending = null; result.destroy(error); return; }
            PromisePrototypeThen(request.promise, data => {
                if (pending === request) pending = null;
                if (retired) return;
                const bytes = new Uint8Array(data);
                if (TypedArrayPrototypeGetLength(bytes) === 0) {
                    ended = true;
                    result.push(null);
                } else {
                    // Completed input is real data, even if pause won the race.
                    // Readable retains it until a reader consumes/resumes it.
                    result.push(ReflectApply(bufferFrom, Buffer, [bytes]));
                }
                start();
            }, error => {
                if (pending === request) pending = null;
                if (retired) return;
                if (!request.cancelled) { result.destroy(error); return; }
                start();
            });
        }
        function stop() {
            stopped = true;
            requested = false;
            result._readableState.reading = false;
            if (pending && !pending.cancelled) {
                pending.cancelled = platform.native.__kandeloFdReadControl(pending.promise, null);
            }
        }
        const result = new Readable({
            ...options,
            read() { requested = true; stopped = false; start(); },
            destroy(error, callback) {
                retired = true;
                try { stop(); }
                catch (cancelError) { callback(error || cancelError); return; }
                callback(error);
            },
        });
        result.fd = fd;
        result.on('pause', () => process.nextTick(() => {
            // As in Node's process-stdin policy, stop only if still paused
            // after the stream transition. A same-turn resume retains demand.
            if (!result.readableFlowing) stop();
        }));
        result.ref = function ref() {
            referenced = true;
            if (pending) platform.native.__kandeloFdReadControl(pending.promise, true);
            return this;
        };
        result.unref = function unref() {
            referenced = false;
            if (pending) platform.native.__kandeloFdReadControl(pending.promise, false);
            return this;
        };
        return result;
    }
    return { readable, writable };
}
