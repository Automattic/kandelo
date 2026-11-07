// SpiderMonkey adapter for the shared Node compatibility bootstrap.
//
// The shared compatibility layer is intentionally the source of truth for
// the JavaScript-level Node module shims. This prefix supplies the qjs-shaped
// std, os, and native surfaces that bootstrap expects, backed by the
// SpiderMonkey shell and Kandelo POSIX helpers.
(function () {
    // Capture the embedding's utilities before removing them from Node's
    // public realm. Closures keep the real shell functions, not user globals.
    const shellGlobalNames = Object.getOwnPropertyNames(globalThis);
    const { print, printErr, putstr, quit,
        setSharedObject, evalInWorker } = globalThis;
    const ecmaGlobalNames = new Set([
        'globalThis', 'Infinity', 'NaN', 'undefined', 'eval', 'isFinite', 'isNaN',
        'parseFloat', 'parseInt', 'decodeURI', 'decodeURIComponent', 'encodeURI',
        'encodeURIComponent', 'escape', 'unescape', 'Object', 'Function',
        'Boolean', 'Symbol', 'Error', 'AggregateError', 'SuppressedError', 'EvalError', 'RangeError',
        'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'Number',
        'BigInt', 'Math', 'Date', 'String', 'RegExp', 'Array', 'Int8Array',
        'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
        'Int32Array', 'Uint32Array', 'BigInt64Array', 'BigUint64Array',
        'Float16Array', 'Float32Array', 'Float64Array', 'Map', 'Set', 'WeakMap',
        'WeakSet', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics',
        'JSON', 'WeakRef', 'FinalizationRegistry', 'Iterator', 'Promise',
        'Reflect', 'Proxy', 'Intl', 'WebAssembly', 'DisposableStack',
        'AsyncDisposableStack', 'Temporal',
    ]);
    if (typeof globalThis.queueMicrotask !== 'function') {
        globalThis.queueMicrotask = function queueMicrotask(callback) {
            Promise.resolve().then(() => callback());
        };
    }

    const shellOs = globalThis.os || {};
    const shellFile = shellOs.file || {};
    const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
    const decoder = typeof TextDecoder === 'function' ? new TextDecoder() : null;
    const nativeJsonParse = JSON.parse.bind(JSON);
    const serializeValue = globalThis.serialize;
    const deserializeValue = globalThis.deserialize;
    const captureSavedStack = globalThis.saveStack;
    // The private bootstrap has its real engine source identity, distinct
    // from guest filenames and Node's node: internal source names.
    const bootstrapStackSource = typeof captureSavedStack === 'function' ? captureSavedStack(1)?.source : undefined;
    const stackSourceStartsWith = Function.prototype.call.bind(String.prototype.startsWith);
    const stackSourceIncludes = Function.prototype.call.bind(String.prototype.includes);
    const callSiteCreate = Object.create;
    const callSiteAssign = Object.assign;
    const callSiteDefine = Object.defineProperty;
    const callSiteString = String;
    const native = globalThis.__kandeloNodeNative || {};
    const workerEnvironment = typeof native.worker === 'function' ? native.worker('environment') : null;
    if (workerEnvironment) workerEnvironment.env = Object.assign(Object.create(null), workerEnvironment.env);
    function environmentOperation(operation, key, value) {
        if (!workerEnvironment) return native.environment(operation, key, value);
        const env = workerEnvironment.env;
        if (operation === 'safeget') {
            return native.environment('allowed') && Object.prototype.hasOwnProperty.call(env, key) ? env[key] : undefined;
        }
        if (operation === 'get') return Object.prototype.hasOwnProperty.call(env, key) ? env[key] : undefined;
        if (operation === 'set') { env[key] = value; return; }
        if (operation === 'unset') { delete env[key]; return; }
        if (operation === 'keys') return Object.keys(env);
        throw new Error('Unknown worker environment operation: ' + operation);
    }

    const asyncApply = Reflect.apply, asyncAssign = Object.assign;
    const asyncCreate = Object.create, asyncFreeze = Object.freeze;
    function runWithAsyncContext(context, fn, receiver, args) {
        const prior = native.getAsyncContext();
        const active = asyncAssign(asyncCreate(null), context, { untrackedTask: true });
        native.setAsyncContext(asyncFreeze(active));
        let completed = false;
        try { const result = asyncApply(fn, receiver, args); completed = true; return result; }
        finally { if (completed) native.setAsyncContext(prior); }
    }
    // The deadline heap owns pending callbacks; reference state is independent
    // of wakeup deadlines. Unreferenced timers remain eligible during live work.
    function createTimerScheduler(now) {
        let nextId = 1, references = 0;
        const pending = new Map(), immediates = new Map(), heap = [];
        let batch = null, batchIndex = 0;
        const earlier = (a, b) => a.due < b.due || a.due === b.due && a.id < b.id;
        function swap(a, b) {
            const item = heap[a]; heap[a] = heap[b]; heap[b] = item;
            heap[a].index = a; heap[b].index = b;
        }
        function up(index) {
            while (index > 0) {
                const parent = (index - 1) >> 1;
                if (!earlier(heap[index], heap[parent])) break;
                swap(index, parent); index = parent;
            }
            return index;
        }
        function down(index) {
            while (index * 2 + 1 < heap.length) {
                let child = index * 2 + 1;
                if (child + 1 < heap.length && earlier(heap[child + 1], heap[child])) child++;
                if (!earlier(heap[child], heap[index])) break;
                swap(index, child); index = child;
            }
        }
        function removeHeap(timer) {
            const index = timer.index;
            if (index < 0) return;
            const last = heap.pop(); timer.index = -1;
            if (index < heap.length) {
                heap[index] = last; last.index = index;
                down(up(index));
            }
        }
        function clear(id) {
            const timer = pending.get(id);
            if (!timer) return;
            pending.delete(id); immediates.delete(id); removeHeap(timer);
            if (timer.referenced) references--;
            timer.fn = null; timer.context = undefined;
        }
        function pruneBatch() {
            while (batch && batchIndex < batch.length && !pending.has(batch[batchIndex].id)) batchIndex++;
            if (batch && batchIndex === batch.length) { batch = null; batchIndex = 0; }
        }
        function schedule(fn, delay, referenced = true, immediate = false, start = now()) {
            const timer = { id: nextId++, fn, context: native.getAsyncContext(), due: start + Math.trunc(delay), referenced, index: -1 };
            pending.set(timer.id, timer);
            if (referenced) references++;
            if (immediate) immediates.set(timer.id, timer);
            else { timer.index = heap.length; heap.push(timer); up(timer.index); }
            return timer.id;
        }
        function runOne() {
            pruneBatch();
            if (!batch) {
                // Snapshot this turn. Callbacks queued by callbacks belong to a
                // later turn; the native loop drains microtasks between calls.
                batch = Array.from(immediates.values()); batchIndex = 0;
                const cutoff = now();
                while (heap.length && heap[0].due <= cutoff) {
                    const timer = heap[0]; removeHeap(timer); batch.push(timer);
                }
                pruneBatch();
            }
            if (!batch) return 0;
            const timer = batch[batchIndex++], fn = timer.fn, context = timer.context;
            clear(timer.id);
            try { runWithAsyncContext(context, fn, undefined, []); } finally { pruneBatch(); }
            return 1;
        }
        return {
            now, schedule, clear,
            ref(id, value) {
                const timer = pending.get(id);
                if (timer && timer.referenced !== value) {
                    references += value ? 1 : -1; timer.referenced = value;
                }
            },
            hasReferences() {
                pruneBatch();
                // Finish callbacks already eligible in an entered turn even
                // when its last referenced callback has just completed.
                return references > 0 || batch !== null;
            },
            runOne,
            nextDelay() {
                pruneBatch();
                if (batch || immediates.size) return 0;
                return heap.length ? Math.max(0, heap[0].due - now()) : null;
            },
        };
    }
    const timerScheduler = createTimerScheduler(() => {
        if (typeof native.monotonicTime !== 'function') throw new Error('Native monotonic timer clock is unavailable');
        return native.monotonicTime();
    });

    function encodeUtf8(value) {
        value = String(value);
        if (encoder) return encoder.encode(value);
        const out = [];
        for (let i = 0; i < value.length; i++) {
            let code = value.charCodeAt(i);
            if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
                const low = value.charCodeAt(i + 1);
                if (low >= 0xdc00 && low <= 0xdfff) {
                    code = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
                    i++;
                }
            }
            if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
            if (code < 0x80) out.push(code);
            else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
            else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
            else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
        return new Uint8Array(out);
    }

    function decodeUtf8(value) {
        if (value == null) return '';
        const bytes = value instanceof Uint8Array ? value :
            value instanceof ArrayBuffer ? new Uint8Array(value) :
            new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        if (decoder) return decoder.decode(bytes);
        let out = '';
        for (const b of bytes) out += String.fromCharCode(b);
        try { return decodeURIComponent(escape(out)); } catch (_) { return out; }
    }

    function errnoFromError(error, fallback) {
        const message = String(error && (error.message || error));
        const match = message.match(/errno\s+(-?\d+)/i);
        return match ? Math.abs(Number(match[1])) : fallback;
    }

    function pathToString(path) {
        if (typeof path === 'string') return path;
        if (path && typeof path.pathname === 'string') return path.pathname;
        if (path instanceof Uint8Array) return decodeUtf8(path);
        return String(path);
    }

    function readFileBytes(path) {
        const data = shellFile.readFile(pathToString(path), 'binary');
        if (typeof data === 'string') return encodeUtf8(data);
        return data instanceof Uint8Array ? data : new Uint8Array(data);
    }

    function readFileText(path) {
        const data = shellFile.readFile(pathToString(path));
        return typeof data === 'string' ? data : decodeUtf8(data);
    }

    function makeMemoryFile(path) {
        const bytes = readFileBytes(path);
        let offset = 0;
        return {
            tell() { return offset; },
            seek(pos, whence) {
                whence = whence === undefined ? std.SEEK_SET : whence;
                if (whence === std.SEEK_SET) offset = pos;
                else if (whence === std.SEEK_CUR) offset += pos;
                else if (whence === std.SEEK_END) offset = bytes.byteLength + pos;
                if (offset < 0) offset = 0;
                if (offset > bytes.byteLength) offset = bytes.byteLength;
            },
            read(buffer, byteOffset, length) {
                const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
                byteOffset = byteOffset || 0;
                length = length === undefined ? view.byteLength - byteOffset : length;
                const n = Math.max(0, Math.min(length, bytes.byteLength - offset));
                view.set(bytes.subarray(offset, offset + n), byteOffset);
                offset += n;
                return n;
            },
            getline() {
                if (offset >= bytes.byteLength) return null;
                let end = offset;
                while (end < bytes.byteLength && bytes[end] !== 10) end++;
                const line = decodeUtf8(bytes.subarray(offset, end));
                offset = end < bytes.byteLength ? end + 1 : end;
                return line;
            },
            close() { offset = bytes.byteLength; return 0; },
        };
    }

    function writeFd(fd, data) {
        const bytes = typeof data === 'string' ? encodeUtf8(data) :
            data instanceof Uint8Array ? data :
            data instanceof ArrayBuffer ? new Uint8Array(data) :
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (typeof shellOs.write === 'function') {
            return shellOs.write(fd, bytes.buffer, bytes.byteOffset, bytes.byteLength);
        }
        if (fd === 2 && typeof printErr === 'function') printErr(decodeUtf8(bytes).replace(/\n$/, ''));
        else if (typeof putstr === 'function') putstr(decodeUtf8(bytes));
        else if (typeof print === 'function') print(decodeUtf8(bytes).replace(/\n$/, ''));
        return bytes.byteLength;
    }

    function tupleFromFileCall(fn, fallbackErrno) {
        try { return [fn(), 0]; } catch (error) { return [null, errnoFromError(error, fallbackErrno)]; }
    }

    const std = {
        SEEK_SET: 0,
        SEEK_CUR: 1,
        SEEK_END: 2,
        getenv(key) {
            const value = environmentOperation('get', String(key));
            return value === undefined ? null : value;
        },
        setenv(key, value) { return environmentOperation('set', String(key), String(value)); },
        unsetenv(key) { return environmentOperation('unset', String(key)); },
        exit(code) {
            if (typeof quit === 'function') quit(code | 0);
            throw new Error('exit ' + (code | 0));
        },
        loadFile(path) {
            try { return readFileText(path); } catch (_) { return null; }
        },
        open(path, mode) {
            mode = mode || 'r';
            if (!/^r|rb$/.test(mode)) return null;
            try { return makeMemoryFile(path); } catch (_) { return null; }
        },
        popen(command) {
            const result = typeof shellOs.popenRead === 'function'
                ? shellOs.popenRead(String(command))
                : { output: '', status: typeof shellOs.system === 'function' ? shellOs.system(String(command)) : 127 };
            const lines = String(result.output || '').split('\n');
            let index = 0;
            return {
                getline() {
                    if (index >= lines.length) return null;
                    const line = lines[index++];
                    if (index === lines.length && line === '') return null;
                    return line;
                },
                close() { return result.status || 0; },
            };
        },
        out: { puts(data) { writeFd(1, data); }, flush() {} },
        err: { puts(data) { writeFd(2, data); }, flush() {} },
    };

    const os = {
        O_RDONLY: 0,
        O_WRONLY: 1,
        O_RDWR: 2,
        O_CREAT: 0o100,
        O_EXCL: 0o200,
        O_TRUNC: 0o1000,
        O_APPEND: 0o2000,
        getcwd() {
            try { return [typeof shellOs.getcwd === 'function' ? shellOs.getcwd() : '/', 0]; }
            catch (error) { return [null, errnoFromError(error, 2)]; }
        },
        chdir(path) { return typeof shellOs.chdir === 'function' ? shellOs.chdir(pathToString(path)) : -2; },
        getpid() { return typeof shellOs.getpid === 'function' ? shellOs.getpid() : 1; },
        kill(pid, signal) { if (typeof shellOs.kill === 'function') return shellOs.kill(pid, signal); return 0; },
        stat(path) { return tupleFromFileCall(() => shellFile.stat(pathToString(path)), 2); },
        lstat(path) { return tupleFromFileCall(() => shellFile.lstat(pathToString(path)), 2); },
        readdir(path) { return tupleFromFileCall(() => shellFile.listDir(pathToString(path)), 2); },
        mkdir(path, mode) { return typeof shellFile.mkdir === 'function' ? shellFile.mkdir(pathToString(path), mode || 0o777) : -38; },
        chmod(path, mode) { return typeof shellFile.chmod === 'function' ? shellFile.chmod(pathToString(path), mode) : -38; },
        fsync(fd) { return typeof shellFile.fsync === 'function' ? shellFile.fsync(fd) : -38; },
        remove(path) { return typeof shellFile.remove === 'function' ? shellFile.remove(pathToString(path)) : -38; },
        rename(oldPath, newPath) { return typeof shellFile.rename === 'function' ? shellFile.rename(pathToString(oldPath), pathToString(newPath)) : -38; },
        symlink(target, linkpath) { return typeof shellFile.symlink === 'function' ? shellFile.symlink(pathToString(target), pathToString(linkpath)) : -38; },
        readlink(path) { return tupleFromFileCall(() => shellFile.readlink(pathToString(path)), 22); },
        realpath(path) { return tupleFromFileCall(() => shellFile.realpath(pathToString(path)), 2); },
        utimes(path, atime, mtime) { return typeof shellFile.utimes === 'function' ? shellFile.utimes(pathToString(path), atime, mtime) : 0; },
        open(path, flags, mode) { return typeof shellOs.open === 'function' ? shellOs.open(pathToString(path), flags, mode || 0o666) : -38; },
        close(fd) { return typeof shellOs.close === 'function' ? shellOs.close(fd) : 0; },
        read(fd, buffer, byteOffset, length) { return typeof shellOs.read === 'function' ? shellOs.read(fd, buffer, byteOffset || 0, length) : -38; },
        pread(fd, buffer, byteOffset, length, position) { return shellOs.pread(fd, buffer, byteOffset, length, position); },
        write(fd, buffer, byteOffset, length) { return writeFd(fd, new Uint8Array(buffer, byteOffset || 0, length)); },
        pwrite(fd, buffer, byteOffset, length, position) { return shellOs.pwrite(fd, buffer, byteOffset, length, position); },
        seek(fd, offset, whence) { return typeof shellOs.seek === 'function' ? shellOs.seek(fd, offset, whence) : -38; },
        fstat(fd) { return typeof shellOs.fstat === 'function' ? shellOs.fstat(fd) : [null, 38]; },
        isatty(fd) { return typeof shellOs.isatty === 'function' ? shellOs.isatty(fd) : false; },
        ttyGetWinSize(fd) { const result = native.operatingSystem('tty-size', fd); return result.error === 0 ? result.value : null; },
        signal() {},
        setReadHandler() {},
        setTimeout(fn, delay, referenced = true, start) { return timerScheduler.schedule(fn, delay, referenced, false, start); },
        clearTimeout(id) { timerScheduler.clear(id); },
        setImmediate(fn, referenced = true) { return timerScheduler.schedule(fn, 0, referenced, true); },
        timerRef(id, value) { timerScheduler.ref(id, value); },
        timerNow() { return timerScheduler.now(); },
    };

    globalThis.__kandeloRunDueTimers = timerScheduler.runOne;
    globalThis.__kandeloNextTimerDelay = timerScheduler.nextDelay;
    globalThis.__kandeloHasReferencedTimers = timerScheduler.hasReferences;

    const _nodeNative = {
        worker(...args) {
            if (typeof native.worker !== 'function') { const error = new Error('Native Worker owner is unavailable'); error.code = 'ERR_NOT_IMPLEMENTED'; throw error; }
            return native.worker(...args);
        },
        signalOperation(...args) { return native.signalOperation(...args); },
        workerEnvironment,

        isInsideNodeModules(frameLimit = 10) {
            if (typeof captureSavedStack !== 'function') {
                const error = new Error('This engine does not expose saved frames for module origin');
                error.code = 'ERR_NOT_IMPLEMENTED'; throw error;
            }
            // Like the target binding, use the first non-internal synchronous
            // source in a bounded actual stack. No parsing mutable Error.stack
            // or guessing origin from a mutable public module object.
            const limit = typeof frameLimit === 'number' && (frameLimit | 0) === frameLimit ? frameLimit : 10;
            if (limit <= 0) return false;
            let frame = captureSavedStack(limit + 1)?.parent;
            for (let i = 0; frame && i < limit; i++, frame = frame.parent) {
                const source = frame.source;
                if (!source || source === bootstrapStackSource || stackSourceStartsWith(source, 'node:')) continue;
                return stackSourceIncludes(source, '/node_modules/') ||
                    stackSourceIncludes(source, '\\node_modules\\') ||
                    stackSourceIncludes(source, '/node_modules\\') ||
                    stackSourceIncludes(source, '\\node_modules/');
            }
            return false;
        },
        getStructuredStack() {
            if (typeof captureSavedStack !== 'function') {
                const error = new Error('This engine does not expose saved frames');
                error.code = 'ERR_NOT_IMPLEMENTED'; throw error;
            }
            // These are actual synchronous frames. Together with the testing
            // util wrapper this is the same two-function capture chain used by
            // pinned MockTracker.module; never pad or infer caller filenames.
            let frame = captureSavedStack();
            const sites = [];
            while (frame) {
                const filename = frame.source === '-e' ? '[eval]' : frame.source;
                const site = callSiteCreate(null);
                callSiteDefine(site, 'getFileName', { __proto__: null, value: function getFileName() { return filename; },
                    writable: true, configurable: true });
                callSiteDefine(sites, sites.length, { __proto__: null, value: site,
                    enumerable: true, writable: true, configurable: true });
                frame = frame.parent;
            }
            return sites;
        },
        getCallerLocation() {
            if (typeof captureSavedStack !== 'function') {
                const error = new Error('This engine does not expose saved frames');
                error.code = 'ERR_NOT_IMPLEMENTED'; throw error;
            }
            // Skip this private adapter and its immediate JS caller, matching
            // the pinned native util binding's caller-of-caller operation.
            const frame = captureSavedStack(3)?.parent?.parent;
            if (!frame || !frame.source) return undefined;
            return [frame.line, frame.column, frame.source];
        },
        captureCallSites(frameCount) {
            if (typeof captureSavedStack !== 'function') {
                const error = new Error('This engine does not expose saved frames');
                error.code = 'ERR_NOT_IMPLEMENTED';
                throw error;
            }
            // The native saved-frame chain includes this adapter and the public
            // util wrapper. Skip exactly those two owned frames; retain actual
            // user and embedding callers, including their engine source IDs.
            let frame = captureSavedStack(frameCount + 2);
            for (let i = 0; i < 2 && frame; i++) frame = frame.parent;
            const sites = [];
            while (frame && sites.length < frameCount) {
                const site = callSiteAssign(callSiteCreate(null), {
                    functionName: frame.functionDisplayName || '',
                    scriptId: callSiteString(frame.sourceId),
                    scriptName: frame.source === '-e' ? '[eval]' : frame.source || '',
                    lineNumber: frame.line,
                    columnNumber: frame.column,
                    column: frame.column,
                });
                callSiteDefine(sites, sites.length, {
                    value: site, enumerable: true, writable: true, configurable: true,
                });
                frame = frame.parent;
            }
            return sites;
        },
        importModule(specifier, parentURL, attributes) {
            return native.importModule(specifier, parentURL, attributes);
        },
        prepareGlobalScope(publicNames) {
            const retained = new Set(publicNames);
            for (const name of shellGlobalNames) {
                if (!ecmaGlobalNames.has(name) && !retained.has(name)) {
                    if (!Reflect.deleteProperty(globalThis, name)) {
                        throw new Error('Cannot remove shell global from Node realm: ' + name);
                    }
                }
            }
        },
        configureClone(symbol, errorFactory, serialize, create, deserialize) {
            return native.configureClone(symbol, errorFactory, serialize, create, deserialize);
        },
        createCloneModeSymbol() { return native.createCloneModeSymbol(); },
        markBufferUntransferable(buffer) { return native.markBufferUntransferable(buffer); },
        objectMark(operation, value) { return native.objectMark(operation, value); },
        defineNativeLazyDataProperty(...args) { return native.defineNativeLazyDataProperty(...args); },
        setCloneMode(object, mode) { return native.setCloneMode(object, mode); },
        hrtime() { return native.hrtime(); },
        operatingSystem(...args) { return native.operatingSystem(...args); },
        getUvErrorData() { return native.getUvErrorData(); },
        environment(operation, key, value) { return environmentOperation(operation, key, value); },
        createEnvironmentObject(callbacks, prototype) { return native.createEnvironmentObject(callbacks, prototype); },
        processUmask(mask) { return native.processUmask(mask); },
        processParentPid() { return native.processParentPid(); },
        // Retain the actual native function's abort name/arity/receiver policy.
        processAbort: native.abort,
        parseEnv(content) { return native.parseEnv(content); },
        loadEnvFile(path) { return native.loadEnvFile(path); },
        randomFillBytes(bytes) { return native.randomFillBytes(bytes); },
        secureRandomBuffer(size) { return native.secureRandomBuffer(size); },
        createRandomBytesJob(prototype, mode, buffer, offset, size, callback) { return native.createRandomBytesJob(prototype, mode, buffer, offset, size, callback); },
        runRandomBytesJob(owner) { return native.runRandomBytesJob(owner); },
        createKdfJob(...args) { return native.createKdfJob(...args); },
        argon2Supported() { return native.argon2Supported(); },
        runKdfJob(owner) { return native.runKdfJob(owner); },
        hashDigest(algorithm, input, outputLength, digestOptions) { return native.hashDigest(algorithm, input, outputLength, digestOptions); },
        digestNames() { return native.digestNames(); },
        getOpenSSLVersion() { return native.getOpenSSLVersion(); },
        timingSafeEqual(a, b) { return native.timingSafeEqual(a, b); },
        eventLoopDelayOperation(...args) { return native.eventLoopDelayOperation(...args); },
        histogramOperation(...args) { return native.histogramOperation(...args); },
        port(operation, owner, value) { return native.port(operation, owner, value); },
        locks(...args) { return native.locks(...args); },
        serializeMessage(value, transfer, sourcePort) {
            return native.serializeMessage(value, transfer, sourcePort);
        },
        deserializeMessage(packet, includePorts) {
            return native.deserializeMessage(packet, includePorts);
        },
        cloneValue(value, transfer) {
            // Keep the engine's structured-clone graph, cycles and byte views;
            // the unrelated global JSON fallback cannot clone stream chunks.
            return native.deserializeMessage(native.serializeMessage(value, transfer));
        },
        isPromise: value => native.isPromise(value),
        isNativeError: Error.isError,
        isProxy: value => native.hasObjectKind(value, 'Proxy'),
        hasObjectKind: (value, kind) => native.hasObjectKind(value, kind),
        getPromiseDetails: value => native.getPromiseDetails(value),
        markPromiseAsHandled: value => native.markPromiseAsHandled(value),
        getProxyDetails: (value, full) => native.getProxyDetails(value, full),
        getConstructorName: value => native.getConstructorName(value),
        getAsyncContext: () => native.getAsyncContext(),
        pushAsyncExecution: (...args) => native.pushAsyncExecution(...args),
        popAsyncExecution: (...args) => native.popAsyncExecution(...args),
        clearAsyncExecution: (...args) => native.clearAsyncExecution(...args),
        executionAsyncId: (...args) => native.executionAsyncId(...args),
        triggerAsyncId: (...args) => native.triggerAsyncId(...args),
        hasAsyncExecution: (...args) => native.hasAsyncExecution(...args),
        executionAsyncResource: (...args) => native.executionAsyncResource(...args),
        setUncaughtProcess: (...args) => native.setUncaughtProcess(...args),
        uncaughtExceptionCaptureToggle: () => native.uncaughtExceptionCaptureToggle(),
        setDomainTrampoline: (...args) => native.setDomainTrampoline(...args),
        allocateAsyncId: () => native.allocateAsyncId(),
        getDefaultTriggerAsyncId: () => native.getDefaultTriggerAsyncId(),
        swapDefaultTriggerAsyncId: value => native.swapDefaultTriggerAsyncId(value),
        setAsyncLifecycle: callback => native.setAsyncLifecycle(callback),
        setAsyncDestroyTracking: enabled => native.setAsyncDestroyTracking(enabled),
        drainNativeAsyncDestroyIds: () => native.drainNativeAsyncDestroyIds(),
        enqueueAsyncDestroyId: (id, promise) => native.enqueueAsyncDestroyId(id, promise),
        getAsyncResourceInfo: resource => native.getAsyncResourceInfo(resource),
        udp(...args) { return native.udp(...args); },
        asyncHookFatal: error => native.asyncHookFatal(error),
        enqueueMicrotask: callback => native.enqueueMicrotask(callback),
        setAsyncContext: value => native.setAsyncContext(value),
        getAsyncJobActive: () => native.getAsyncJobActive(),
        runWithAsyncContext,
        previewEntries: (value, pairs) => native.previewEntries(value, pairs),
        moduleSyntax(operation, source, filename) { return native.moduleSyntax(operation, source, filename); },
        httpParser(...args) { return native.httpParser(...args); },
        wasiConstructor() { return native.wasiConstructor(); },
        seaBinding() { return native.seaBinding(); },
        evalScriptAsFunction(source, filename, firstLine = 1) {
            if (typeof native.evalScriptAsFunction === 'function') {
                return native.evalScriptAsFunction(source, filename, firstLine);
            }
            return (0, eval)(source + '\n//# sourceURL=' + filename);
        },
        decodeUtf8(bytes) { return decodeUtf8(bytes); },
        jsonParse(text) { return nativeJsonParse(text); },
        __kandeloRequireModule(path) {
            if (typeof native.__kandeloRequireModule !== 'function') {
                throw new Error('native __kandeloRequireModule is unavailable');
            }
            return native.__kandeloRequireModule(path);
        },
        getCompressionVersions() { return native.getCompressionVersions(); },
        getBufferLimits() { return native.getBufferLimits(); },
        engineGcHeapLimit() { return native.engineGcHeapLimit(); },
        addressRules(operation, ...args) { return native.addressRules(operation, ...args); },
        getFsConstants() { return native.getFsConstants(); },
        createUnsafeArrayBuffer(size) { return native.createUnsafeArrayBuffer(size); },
        arrayBufferAlignedOffset(buffer, alignment) { return native.arrayBufferAlignedOffset(buffer, alignment); },
        fsControlSync(name, fd, first, second) { return native.fsControlSync(name, fd, first, second); },
        fsControlPromise(name, fd, first, second, makeError) { return native.fsControlPromise(name, fd, first, second, makeError); },
        fsIoPromise(writing, fd, buffer, offset, length, position, makeError) { return native.fsIoPromise(writing, fd, buffer, offset, length, position, makeError); },
        fsVectorPromise(writing, fd, buffers, position, makeError) { return native.fsVectorPromise(writing, fd, buffers, position, makeError); },
        fsStatPromise(pathOrFd, bigint, request, follow, throwIfNoEntry) { return native.fsStatPromise(pathOrFd, bigint, request, follow, throwIfNoEntry); },
        fsStatSync(pathOrFd, follow, bigint) { return native.fsStatSync(pathOrFd, follow, bigint); },
        cpSyncCheckPaths(...args) { return native.cpSyncCheckPaths(...args); },
        cpSyncOverrideFile(...args) { return native.cpSyncOverrideFile(...args); },
        cpSyncCopyDir(...args) { return native.cpSyncCopyDir(...args); },
        createCpDirJob(...args) { return native.createCpDirJob(...args); },
        runCpDirJob(owner) { return native.runCpDirJob(owner); },
        fsCopyFileSync(src, dest, mode) { return native.fsCopyFileSync(src, dest, mode); },
        fsCopyFile(src, dest, mode, request) { return native.fsCopyFile(src, dest, mode, request); },
        fsRmSync(path, retries, recursive, delay) { return native.fsRmSync(path, retries, recursive, delay); },
        fsScandir(path, request, prototype) { return native.fsScandir(path, request, prototype); },
        fsReaddirSync(path, recursive, withTypes, convert) { return native.fsReaddirSync(path, recursive, withTypes, convert); },
        fsReaddirPromise(path, recursive, withTypes, request, convert) { return native.fsReaddirPromise(path, recursive, withTypes, request, convert); },
        fsPathSync(name, path, mode, recursive) { return native.fsPathSync(name, path, mode, recursive); },
        fsPathPromise(name, path, mode, recursive, request, convert) { return native.fsPathPromise(name, path, mode, recursive, request, convert); },
        fsMetadataSync(name, path, first, second, convert) { return native.fsMetadataSync(name, path, first, second, convert); },
        fsMetadataPromise(name, path, first, second, request, convert) { return native.fsMetadataPromise(name, path, first, second, request, convert); },
        fsOpenPromise(path, flags, mode, makeError) { return native.fsOpenPromise(path, flags, mode, makeError); },
        fsOpenSync(path, flags, mode) { return native.fsOpenSync(path, flags, mode); },
        fsIoSync(writing, fd, buffer, offset, length, position) { return native.fsIoSync(writing, fd, buffer, offset, length, position); },
        fsVectorSync(writing, fd, buffers, position) { return native.fsVectorSync(writing, fd, buffers, position); },
        createReadFileJob(prototype, path, flags, limit, trackFd, callback, bufferPrototype) { return native.createReadFileJob(prototype, path, flags, limit, trackFd, callback, bufferPrototype); },
        runReadFileJob(job) { return native.runReadFileJob(job); },
        createWriteFileJob(...args) { return native.createWriteFileJob(...args); },
        runWriteFileJob(job) { return native.runWriteFileJob(job); },
        cancelFsRequest(request) { return native.cancelFsRequest(request); },
        createFsRequest(prototype, callback) { return native.createFsRequest(prototype, callback); },
        statWatcher(...args) { return native.statWatcher(...args); },
        ftruncate(fd, length, request) { return native.ftruncate(fd, length, request); },
        closeDescriptor(fd, request) { return native.closeDescriptor(fd, request); },
        adoptFileHandle(fd, path, makeError) { return native.adoptFileHandle(fd, path, makeError); },
        peekFsGcCloseError() { return native.peekFsGcCloseError(); },
        ackFsGcCloseError() { return native.ackFsGcCloseError(); },
        sqlite(...args) { return native.sqlite(...args); },
        getCompressionConstants() { return native.getCompressionConstants(); },
        createCompressionHandle(mode, prototype) { return native.createCompressionHandle(mode, prototype); },
        crc32(data, value) { return native.crc32(data, value); },
        __kandeloZstdDecompress(bytes) {
            if (typeof native.__kandeloZstdDecompress !== 'function') throw new Error('native __kandeloZstdDecompress is unavailable');
            return native.__kandeloZstdDecompress(bytes);
        },
        __kandeloVmMakeContext(sandbox, opts) {
            if (typeof native.__kandeloVmMakeContext !== 'function') throw new Error('native __kandeloVmMakeContext is unavailable');
            return native.__kandeloVmMakeContext(sandbox, opts);
        },
        __kandeloVmIsContext(obj) { return typeof native.__kandeloVmIsContext === 'function' && native.__kandeloVmIsContext(obj); },
        __kandeloVmRunInContext(codeOrScript, ctx, opts) {
            if (typeof native.__kandeloVmRunInContext !== 'function') throw new Error('native __kandeloVmRunInContext is unavailable');
            return native.__kandeloVmRunInContext(codeOrScript, ctx, opts);
        },
        __kandeloVmModuleOperation(...args) {
            if (typeof native.__kandeloVmModuleOperation !== 'function') throw new Error('native VM module records are unavailable');
            return native.__kandeloVmModuleOperation(...args);
        },
        __kandeloVmCompileFunction(code, params, context, opts, extensions) {
            if (typeof native.__kandeloVmCompileFunction !== 'function') throw new Error('native __kandeloVmCompileFunction is unavailable');
            return native.__kandeloVmCompileFunction(code, params, context, opts, extensions);
        },
        __kandeloVmRegisterImport(owner, registry) {
            if (typeof native.__kandeloVmRegisterImport !== 'function') throw new Error('native __kandeloVmRegisterImport is unavailable');
            return native.__kandeloVmRegisterImport(owner, registry);
        },
        __kandeloVmCompile(code, opts) {
            if (typeof native.__kandeloVmCompile !== 'function') throw new Error('native __kandeloVmCompile is unavailable');
            return native.__kandeloVmCompile(code, opts);
        },
        setRawMode: typeof native.setRawMode === 'function' ? (fd, raw) => native.setRawMode(fd, raw) : undefined,
        keyOperation(operation, ...args) { return native.keyOperation(operation, ...args); },
        x509Operation(...args) { return native.x509Operation(...args); },
        cipherOperation(operation, ...args) { return native.cipherOperation(operation, ...args); },
        signatureOperation(operation, ...args) { return native.signatureOperation(operation, ...args); },
        isKeyObject(value) { return native.keyOperation('isKeyObject', value).value; },
        isCryptoKey(value) { return native.keyOperation('isCryptoKey', value).value; },
        incrementalHash(operation, ...args) { return native.incrementalHash(operation, ...args); },
        fsDirOpen(path, prototype, request) { return native.dirOperation('open', path, prototype, request); },
        fsDirRead(owner, maximum, request, convert) { return native.dirOperation('read', owner, maximum, request, convert); },
        fsDirClose(owner, request) { return native.dirOperation('close', owner, request); },
        packageOperation(...args) { return native.packageOperation(...args); },
        createDeflate(level) { return native.createDeflate(level); },
        createInflate() { return native.createInflate(); },
        createGzip(level) { return native.createGzip(level); },
        createGunzip() { return native.createGunzip(); },
        createUnzip() { return native.createUnzip(); },
        deflateSync(input, level) { return native.deflateSync(input, level); },
        inflateSync(input) { return native.inflateSync(input); },
        gzipSync(input, level) { return native.gzipSync(input, level); },
        gunzipSync(input) { return native.gunzipSync(input); },
        createDnsRequest(prototype, nameInfo) { return native.createDnsRequest(prototype, nameInfo); },
        createDnsChannel(prototype, timeout, tries, maxTimeout) { return native.createDnsChannel(prototype, timeout, tries, maxTimeout); },
        dnsQuery(channel, request, hostname, type) { return native.dnsQuery(channel, request, hostname, type); },
        dnsGetServers(channel) { return native.dnsGetServers(channel); },
        dnsSetServers(channel, servers) { return native.dnsSetServers(channel, servers); },
        dnsSetLocalIP(channel, family, address) { return native.dnsSetLocalIP(channel, family, address); },
        dnsCancel(channel) { return native.dnsCancel(channel); },
        dnsStrError(code) { return native.dnsStrError(code); },
        dnsVersion() { return native.dnsVersion(); },
        dnsLookup(req, asciiHostname, family, hints, order) {
            return native.dnsLookup(req, asciiHostname, family, hints, order);
        },
        dnsLookupService(req, address, port) { return native.dnsLookupService(req, address, port); },
        dnsLookupConstants() { return native.dnsLookupConstants(); },
        performanceNow() { return native.performanceNow(); },
        performanceTimeOrigin() { return native.performanceTimeOrigin(); },
        performanceLoopState() { return native.performanceLoopState(); },
        performanceMilestone(name) { return native.performanceMilestone(name); },
        performanceBootstrapComplete() { return native.performanceBootstrapComplete(); },
        socketLookup(host, family, hints) { return native.socketLookup(host, family, hints); },
        socketConnect(host, port, family, localAddress, localPort) {
            return native.socketConnect(host, port, family, localAddress, localPort);
        },
        socketCancelConnect(promise) { return native.socketCancelConnect(promise); },
        socketListen(...args) { return native.socketListen(...args); },
        socketAccept(fd) { return native.socketAccept(fd); },
        socketAcceptLease(fd) { return native.socketAccept(fd, true); },
        socketAcceptedFd(lease) { return native.socketAcceptedFd(lease); },
        socketAcceptedClose(lease) { return native.socketAcceptedClose(lease); },
        socketOwnerAdoptAccepted(lease) { return native.socketOwnerAdoptAccepted(lease); },
        DynamicLibrary: native.DynamicLibrary,
        ffiMemory: native.ffiMemory,
        socketOwnerCreate() { return native.socketOwnerCreate(); },
        socketOwnerAdopt(fd) { return native.socketOwnerAdopt(fd); },
        socketOwnerConnect(...args) { return native.socketOwnerConnect(...args); },
        socketOwnerCancelConnect(token) { return native.socketOwnerCancelConnect(token); },
        socketOwnerRefConnect(token, referenced) { return native.socketOwnerRefConnect(token, referenced); },
        socketOwnerOfConnect(token) { return native.socketOwnerOfConnect(token); },
        socketOwnerAbortAdoption(owner) { return native.socketOwnerAbortAdoption(owner); },
        socketOwnerValidate(owner) { return native.socketOwnerValidate(owner); },
        socketOwnerCommitAdoption(owner) { return native.socketOwnerCommitAdoption(owner); },
        socketShutdownRequest(owner) { return native.socketShutdownRequest(owner); },
        socketShutdown(fd) { return native.socketShutdown(fd); },
        socketRef(handle, referenced) { return native.socketRef(handle, referenced); },
        socketAddress(fd, peer) { return native.socketAddress(fd, peer); },
        socketRead(fd, length) { return native.socketRead(fd, length); },
        socketWrite(fd, bytes) { return native.socketWrite(fd, bytes); },
        socketClose(fd) { return native.socketClose(fd); },
        socketWriteQueueSize(fd) { return native.socketWriteQueueSize(fd); },
        __kandeloPipe(parentReads, minimumFd) { return native.__kandeloPipe(parentReads, minimumFd); },
        __kandeloRunChildSync: typeof native.__kandeloRunChildSync === 'function'
            ? function (pid, fds, input, deadline, maxBuffer, signal) { return native.__kandeloRunChildSync(pid, fds, input, deadline, maxBuffer, signal); }
            : undefined,
        __kandeloSpawn(file, argv, env, actions, attrs) { return native.__kandeloSpawn(file, argv, env, actions, attrs); },
        __kandeloFdRead(fd, max, nonblocking) {
            return nonblocking === true ? native.__kandeloFdRead(fd, max, true) : native.__kandeloFdRead(fd, max);
        },
        __kandeloFdReadControl: typeof native.__kandeloFdReadControl === 'function'
            ? function (promise, mode) { return native.__kandeloFdReadControl(promise, mode); }
            : undefined,
        __kandeloFdWrite(fd, bytes) { return native.__kandeloFdWrite(fd, bytes); },
        __kandeloFdClose(fd) { return native.__kandeloFdClose(fd); },
        __kandeloWaitPid(pid) { return native.__kandeloWaitPid(pid); },
        credentials() { return native.credentials(); },
        __kandeloKill(pid, sig) { return native.__kandeloKill(pid, sig); },
        tlsContext(...args) { return native.__kandeloTlsContextOperation(...args); },
        tlsPrepare(...args) { return native.tlsPrepare(...args); },
        tlsConnect(owner) { return native.tlsConnect(owner); },
        tlsRef(...args) { return native.tlsRef(...args); },
        tlsInfo(handle, operation) { return native.tlsInfo(handle, operation); },
        tlsRead(handle, length) { return native.tlsRead(handle, length); },
        tlsReadRelease(...args) { return native.tlsReadRelease(...args); },
        tlsWrite(handle, bytes) { return native.tlsWrite(handle, bytes); },
        tlsWriteRelease(...args) { return native.tlsWriteRelease(...args); },
        tlsClose(handle) { return native.tlsClose(handle); },
        tlsX509(...args) { return native.tlsX509(...args); },
    };

    const entryPath = workerEnvironment ? '' : (typeof scriptPath === 'string' && scriptPath ? scriptPath : '');
    const args = workerEnvironment ? [] : (typeof scriptArgs !== 'undefined' ? Array.from(scriptArgs) : []);
    _nodeNative.mainScriptPath = entryPath;
    _nodeNative.cliOptions = workerEnvironment ? workerEnvironment.cliOptions : (globalThis.__kandeloNodeCliOptions || {});

    const argv0 = 'node';
    let execArgv;
    // Native Worker preparation has no user LOAD argv/entry yet. The actual
    // decoded graph applies them after builtin clone owners initialize.
    if (workerEnvironment) execArgv = ['node'];
    else execArgv = entryPath ? ['node', entryPath, ...args] : ['node', ...args];
