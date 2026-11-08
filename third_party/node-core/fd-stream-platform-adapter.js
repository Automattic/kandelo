// FD transport beneath the shared stream state machines. These owners borrow
// public stdio descriptors. Supported TTYs initialize a real reopened OFD;
// later stream transitions never close or reuse the borrowed public number.
// Exact public Socket/TTY/file subclasses remain separate integration work.
function _createNodeFdStreamPlatform(platform) {
    'use strict';
    const P = _createNodePrimordials();
    const { PromisePrototypeThen, ReflectApply, TypedArrayPrototypeGetLength,
        TypedArrayPrototypeGetBuffer, TypedArrayPrototypeGetByteOffset,
        TypedArrayPrototypeGetByteLength } = P;
    const FastBuffer = platform.FastBuffer;
    // Native producers publish independently owned Uint8Array byte spans.
    // Like pinned onStreamRead, retain exactly that allocation/offset/count
    // without public Buffer.from, valueOf, iterator or view-property lookup.
    const publishBytes = bytes => new FastBuffer(TypedArrayPrototypeGetBuffer(bytes),
        TypedArrayPrototypeGetByteOffset(bytes), TypedArrayPrototypeGetByteLength(bytes));
    const { Readable, Writable } = platform.stream;
    const process = platform.process;
    /* NODE_STDIO_DUMMY_DESTROY */

    function writable(fd, options, publish) {
        const terminalOutput = platform.openTerminalOutput ? platform.openTerminalOutput(fd) : null;
        // A verified blocking TTY owner completes actual libc writes first.
        // The generic async operation owns copied bytes through readiness
        // waits. Writable owns serialization, HWM, drain,
        // encoding, callback-once and end/final/error state above that seam.
        function writeTerminal(chunk, callback, vector = false) {
            const operation = { callback, entered: false, settled: false, published: false };
            let status;
            try { status = vector ? terminalOutput.writev(chunk, operation) : terminalOutput.write(chunk, operation); }
            catch (error) {
                // A replayed completion/user callback exception is not a
                // second submission failure. Preserve it on its real path.
                if (operation.entered || operation.published) throw error;
                operation.settled = true;callback(error);return;
            }
            if (status !== true && !operation.settled) {
                operation.settled = true;callback(status);
            }
        }
        let result;
        try { result = new Writable({
            ...options,
            ...(terminalOutput ? { writev(chunks, callback) {
                // Pinned all-buffer preparation mutates the already-owned
                // entries by index. Array species/constructor hooks do not
                // participate. Native mixed/string support is still separate.
                for (let i = 0; i < chunks.length; i++) chunks[i] = chunks[i].chunk;
                writeTerminal(chunks, callback, true);
            } } : {}),
            write(chunk, encoding, callback) {
                if (terminalOutput) return writeTerminal(chunk, callback);
                let promise;
                try { promise = platform.native.__kandeloFdWrite(fd, chunk); }
                catch (error) { callback(error); return; }
                PromisePrototypeThen(promise, () => callback(), error => callback(error));
            },
        });
        if (terminalOutput) terminalOutput.bind(result);
        result.fd = fd;
        result._isStdio = true;
        result.destroySoon = result.destroy;
        // Match the target process-specific destroy policy: close is observable
        // but fd 1/2 remain open and the JS stream can be used again.
        result._destroy = dummyDestroy;
        if (publish !== undefined) publish(result);
        return result;
        } catch (error) {
            // Preserve the original construction/publication exception. A
            // failed new Writable or later setter/bind must not abandon its
            // already-captured native TTY descriptor until a future GC.
            try { if (terminalOutput) terminalOutput.close(); } catch (_) {}
            throw error;
        }
    }

    function readable(fd, options, onRetire) {
        const terminalInput = platform.openTerminalInput ? platform.openTerminalInput(fd) : null;
        const read = terminalInput ? length => terminalInput.read(length) :
            length => platform.native.__kandeloFdRead(fd, length, true);
        const control = terminalInput ? (promise, value) => terminalInput.control(promise, value) :
            (promise, value) => platform.native.__kandeloFdReadControl(promise, value);
        let pending = null, requested = false, stopped = false;
        let referenced = true, ended = false, retired = false;
        function start() {
            if (pending || !requested || stopped || ended || retired) return;
            requested = false;
            if (terminalInput?.start) {
                const request = { nativeCallback: true, cancelled: false };
                pending = request;
                let error;
                try {
                    terminalInput.ref(referenced);
                    error = terminalInput.start(4096, (status, data) => {
                        if (pending === request) pending = null;
                        if (retired || request.cancelled) return;
                        if (status) {
                            result.destroy(terminalInput.error(status));
                            return;
                        }
                        const bytes = data;
                        if (TypedArrayPrototypeGetLength(bytes) === 0) {
                            ended = true;result.push(null);
                        } else result.push(publishBytes(bytes));
                        start();
                    });
                } catch (failure) { error = failure; }
                if (error) { if (pending === request) pending = null;result.destroy(error); }
                return;
            }
            let request;
            try {
                request = { promise: read(4096), cancelled: false };
                pending = request;
                if (!referenced) control(request.promise, false);
            } catch (error) { pending = null; result.destroy(error); return; }
            PromisePrototypeThen(request.promise, data => {
                if (pending === request) pending = null;
                if (retired) return;
                const bytes = data;
                if (TypedArrayPrototypeGetLength(bytes) === 0) {
                    ended = true;
                    result.push(null);
                } else {
                    // Completed input is real data, even if pause won the race.
                    // Readable retains it until a reader consumes/resumes it.
                    result.push(publishBytes(bytes));
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
                if (pending.nativeCallback) {
                    const request = pending;
                    request.cancelled = terminalInput.stop();
                    if (request.cancelled && pending === request) pending = null;
                } else pending.cancelled = control(pending.promise, null);
            }
        }
        let result;
        try { result = new Readable({
            ...options,
            read() { requested = true; stopped = false; start(); },
            destroy(error, callback) {
                retired = true;
                let failure = error;
                try { stop(); }
                catch (cancelError) { failure = failure || cancelError; }
                // Resource retirement follows the actual transport owner,
                // never a user-emitted public close notification.
                try { if (terminalInput) terminalInput.close();if (onRetire) onRetire(); }
                catch (retireError) { failure = failure || retireError; }
                callback(failure);
            },
        });
            if (terminalInput) terminalInput.bind(result);
        } catch (error) {
            // Preserve the original constructor/publication failure after
            // closing the actual owner; cleanup allocation errors cannot
            // replace the exception that prevented stream publication.
            try { if (terminalInput) terminalInput.close(); } catch (_) {}
            throw error;
        }
        result.fd = fd;
        result.on('pause', () => process.nextTick(() => {
            // As in Node's process-stdin policy, stop only if still paused
            // after the stream transition. A same-turn resume retains demand.
            if (!result.readableFlowing) stop();
        }));
        result.ref = function ref() {
            referenced = true;
            if (terminalInput?.start) terminalInput.ref(true);
            else if (pending) control(pending.promise, true);
            return this;
        };
        result.unref = function unref() {
            referenced = false;
            if (terminalInput?.start) terminalInput.ref(false);
            else if (pending) control(pending.promise, false);
            return this;
        };
        return result;
    }
    return { readable, writable };
}
