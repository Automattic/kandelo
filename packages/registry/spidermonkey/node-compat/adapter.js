// SpiderMonkey adapter for the shared Node compatibility bootstrap.
//
// The shared compatibility layer is intentionally the source of truth for
// the JavaScript-level Node module shims. This prefix supplies the qjs-shaped
// std, os, and native surfaces that bootstrap expects, backed by the
// SpiderMonkey shell and Kandelo POSIX helpers.
(function () {
    const _adapterOwnGlobals = Object.getOwnPropertyNames(globalThis);
    for (const name of _adapterOwnGlobals) {
        if (name === 'globalThis') continue;
        const desc = Object.getOwnPropertyDescriptor(globalThis, name);
        if (desc && desc.enumerable && desc.configurable) {
            try { Object.defineProperty(globalThis, name, { ...desc, enumerable: false }); } catch (_) {}
        }
    }

    function defineAdapterGlobal(name, value) {
        Object.defineProperty(globalThis, name, {
            value,
            writable: true,
            configurable: true,
            enumerable: false,
        });
    }

    if (typeof globalThis.queueMicrotask !== 'function') {
        defineAdapterGlobal('queueMicrotask', function queueMicrotask(callback) {
            Promise.resolve().then(() => callback());
        });
    }

    const shellOs = globalThis.os || {};
    const shellFile = shellOs.file || {};
    const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
    const decoder = typeof TextDecoder === 'function' ? new TextDecoder() : null;
    const nativeJsonParse = JSON.parse.bind(JSON);
    let nextTimerId = 1;
    const pendingTimers = new Map();

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
            if (typeof shellOs.getenv !== 'function') return null;
            const value = shellOs.getenv(String(key));
            return value === undefined ? null : value;
        },
        setenv(key, value) {
            // Keep process.env mutations in the shared JS bootstrap's env
            // object. SpiderMonkey's wasm shell inherits Mozilla setenv
            // interposition machinery that aborts when user JS calls through
            // to libc setenv(), and npm mutates process.env during startup.
            void key;
            void value;
        },
        unsetenv(key) {
            void key;
        },
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
            const output = String(result.output || '');
            const lines = output.split('\n');
            let index = 0;
            return {
                readAll() {
                    index = lines.length;
                    return output;
                },
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
        remove(path) { return typeof shellFile.remove === 'function' ? shellFile.remove(pathToString(path)) : -38; },
        rename(oldPath, newPath) { return typeof shellFile.rename === 'function' ? shellFile.rename(pathToString(oldPath), pathToString(newPath)) : -38; },
        symlink(target, linkpath) { return typeof shellFile.symlink === 'function' ? shellFile.symlink(pathToString(target), pathToString(linkpath)) : -38; },
        readlink(path) { return tupleFromFileCall(() => shellFile.readlink(pathToString(path)), 22); },
        realpath(path) { return tupleFromFileCall(() => shellFile.realpath(pathToString(path)), 2); },
        utimes(path, atime, mtime) { return typeof shellFile.utimes === 'function' ? shellFile.utimes(pathToString(path), atime, mtime) : 0; },
        open(path, flags, mode) { return typeof shellOs.open === 'function' ? shellOs.open(pathToString(path), flags, mode || 0o666) : -38; },
        close(fd) { return typeof shellOs.close === 'function' ? shellOs.close(fd) : 0; },
        read(fd, buffer, byteOffset, length) { return typeof shellOs.read === 'function' ? shellOs.read(fd, buffer, byteOffset || 0, length) : -38; },
        write(fd, buffer, byteOffset, length) { return writeFd(fd, new Uint8Array(buffer, byteOffset || 0, length)); },
        seek(fd, offset, whence) { return typeof shellOs.seek === 'function' ? shellOs.seek(fd, offset, whence) : -38; },
        fstat(fd) { return typeof shellOs.fstat === 'function' ? shellOs.fstat(fd) : [null, 38]; },
        isatty(fd) { return typeof shellOs.isatty === 'function' ? shellOs.isatty(fd) : false; },
        ttyGetWinSize(fd) { return typeof shellOs.ttyGetWinSize === 'function' ? shellOs.ttyGetWinSize(fd) : null; },
        signal() {},
        setReadHandler() {},
        setTimeout(fn, delay) {
            const id = nextTimerId++;
            const ms = Math.max(0, Number(delay) || 0);
            pendingTimers.set(id, { fn, due: Date.now() + ms });
            if (ms === 0) {
                queueMicrotask(() => runTimer(id));
            }
            return id;
        },
        clearTimeout(id) { pendingTimers.delete(id); },
    };

    function runTimer(id) {
        const timer = pendingTimers.get(id);
        if (!timer) return false;
        pendingTimers.delete(id);
        timer.fn();
        return true;
    }

    function runDueTimers() {
        let ran = 0;
        while (true) {
            const now = Date.now();
            const dueIds = [];
            for (const [id, timer] of pendingTimers) {
                if (timer.due <= now) dueIds.push(id);
            }
            if (dueIds.length === 0) break;
            for (const id of dueIds) {
                if (runTimer(id)) ran++;
            }
        }
        return ran;
    }

    function nextTimerDelay() {
        let next = Infinity;
        const now = Date.now();
        for (const timer of pendingTimers.values()) {
            if (timer.due < next) next = timer.due;
        }
        return next === Infinity ? null : Math.max(0, next - now);
    }

    defineAdapterGlobal('__kandeloRunDueTimers', runDueTimers);
    defineAdapterGlobal('__kandeloNextTimerDelay', nextTimerDelay);

    defineAdapterGlobal('__kandeloCreateWorkerThreads', function createWorkerThreads(EventEmitter, asyncHooks) {
        const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
        const markedUntransferable = new WeakSet();
        const broadcastChannels = new Map();
        let nextThreadId = 1;

        function defer(fn) {
            if (typeof queueMicrotask === 'function') queueMicrotask(fn);
            else Promise.resolve().then(fn);
        }

        function makeCodedTypeError(message, code) {
            const err = new TypeError(message);
            err.code = code;
            return err;
        }

        function invalidThis(kind) {
            return makeCodedTypeError(`Value of "this" must be of type ${kind}`, 'ERR_INVALID_THIS');
        }

        function invalidPortArg() {
            return makeCodedTypeError('The "port" argument must be a MessagePort instance', 'ERR_INVALID_ARG_TYPE');
        }

        function dataCloneError(message) {
            let err;
            if (typeof globalThis.DOMException === 'function') {
                err = new globalThis.DOMException(message, 'DataCloneError');
            } else {
                err = new Error(message);
                err.name = 'DataCloneError';
            }
            err.code = 25;
            return err;
        }

        function createAsyncResource(type, resource) {
            if (!asyncHooks || typeof asyncHooks.AsyncResource !== 'function') return null;
            try {
                return new asyncHooks.AsyncResource(type, { resource });
            } catch {
                return null;
            }
        }

        function destroyAsyncResource(resource) {
            if (resource && resource._kandeloAsyncResource &&
                typeof resource._kandeloAsyncResource.emitDestroy === 'function') {
                resource._kandeloAsyncResource.emitDestroy();
            }
        }

        function invalidTransferList(message) {
            return makeCodedTypeError(message, 'ERR_INVALID_ARG_TYPE');
        }

        function iterableToArray(value, message) {
            if (value == null || typeof value[Symbol.iterator] !== 'function') {
                throw invalidTransferList(message);
            }
            try {
                return Array.from(value);
            } catch {
                throw invalidTransferList(message);
            }
        }

        function transferListFrom(options) {
            if (options == null) return [];
            if (Array.isArray(options)) return options;
            if (typeof options === 'object' && Object.prototype.hasOwnProperty.call(options, 'transfer')) {
                if (options.transfer === undefined) return [];
                return iterableToArray(options.transfer, 'Optional options.transfer argument must be an iterable');
            }
            if (typeof options === 'object' && typeof options[Symbol.iterator] !== 'function') return [];
            return iterableToArray(options, 'Optional transferList argument must be an iterable');
        }

        function isObject(value) {
            return (typeof value === 'object' && value !== null) || typeof value === 'function';
        }

        function findMessagePort(value, seen) {
            if (value instanceof MessagePort) return value;
            if (!isObject(value)) return null;
            if (!seen) seen = new Set();
            if (seen.has(value)) return null;
            seen.add(value);
            for (const key of Object.keys(value)) {
                const found = findMessagePort(value[key], seen);
                if (found) return found;
            }
            return null;
        }

        function assertCloneableForPort(message, transferList) {
            for (const item of transferList) {
                if (isObject(item) && markedUntransferable.has(item)) {
                    throw dataCloneError('Cannot transfer object marked as untransferable');
                }
            }
            const port = findMessagePort(message);
            if (port && !transferList.includes(port)) {
                throw dataCloneError('Object that needs transfer was found in message but not listed in transferList');
            }
        }

        function cloneMessageForDelivery(message, transferList) {
            assertCloneableForPort(message, transferList);
            if (typeof structuredClone !== 'function') return message;
            try {
                const transferable = transferList.filter((item) => !(item instanceof MessagePort));
                return transferable.length ? structuredClone(message, { transfer: transferable }) : structuredClone(message);
            } catch (error) {
                if (findMessagePort(message) || transferList.some((item) => item instanceof MessagePort)) return message;
                throw error;
            }
        }

        function assertBroadcastCloneable(message) {
            if (typeof message === 'symbol') {
                throw dataCloneError(`${String(message)} could not be cloned`);
            }
            if (findMessagePort(message)) {
                throw dataCloneError('Object that needs transfer was found in message but not listed in transferList');
            }
        }

        function makeMessageEvent(type, data, target, ports) {
            const EventClass = typeof globalThis.MessageEvent === 'function'
                ? globalThis.MessageEvent
                : class MessageEvent {
                    constructor(eventType, init) {
                        this.type = eventType;
                        this.data = init && init.data;
                        this.origin = '';
                        this.lastEventId = '';
                        this.source = null;
                        this.ports = [];
                    }
                };
            const event = new EventClass(type, {
                data,
                origin: '',
                lastEventId: '',
                source: null,
                ports: ports || [],
            });
            try { event.target = target; } catch {}
            try { event.currentTarget = target; } catch {}
            return event;
        }

        function invokeEventListener(listener, target, event) {
            if (typeof listener === 'function') listener.call(target, event);
            else if (listener && typeof listener.handleEvent === 'function') listener.handleEvent(event);
        }

        function unsupportedWorkerMessageApi(member) {
            const err = new Error('SpiderMonkey shell workers expose eval-time workerData/shared memory, not a bidirectional worker_threads message channel');
            err.code = 'ERR_KANDELO_UNSUPPORTED_NODE_API';
            err.api = member;
            return err;
        }

        class MessagePortEventTarget extends EventEmitter {
            constructor() {
                super();
                this._eventListeners = new Map();
                this._queue = [];
                this._scheduled = false;
                this._closed = false;
                this._closing = false;
                this._refed = false;
                this._peer = null;
                this._kandeloAsyncResource = createAsyncResource('MESSAGEPORT', this);
            }

            on(event, listener) {
                const ret = super.on(event, listener);
                if (event === 'message') {
                    this.ref();
                    schedulePortFlush(this);
                }
                return ret;
            }

            once(event, listener) {
                const ret = super.once(event, listener);
                if (event === 'message') {
                    this.ref();
                    schedulePortFlush(this);
                }
                return ret;
            }

            emit(event, ...args) {
                const emitted = super.emit(event, ...args);
                if (event !== 'message') {
                    const listeners = Array.from(this._eventListeners.get(event) || []);
                    if (listeners.length) {
                        const eventObject = args[0] && typeof args[0] === 'object' && args[0].type
                            ? args[0]
                            : { type: event, detail: args[0], target: this, currentTarget: this, defaultPrevented: false };
                        for (const listener of listeners) invokeEventListener(listener, this, eventObject);
                    }
                }
                return emitted;
            }

            addEventListener(type, listener) {
                if (!this._eventListeners.has(type)) this._eventListeners.set(type, new Set());
                this._eventListeners.get(type).add(listener);
                if (type === 'message') {
                    this.ref();
                    schedulePortFlush(this);
                }
            }

            removeEventListener(type, listener) {
                const listeners = this._eventListeners.get(type);
                if (listeners) listeners.delete(listener);
            }

            dispatchEvent(event) {
                const listeners = Array.from(this._eventListeners.get(event.type) || []);
                for (const listener of listeners) invokeEventListener(listener, this, event);
                return !event.defaultPrevented;
            }
        }

        function MessagePort() {
            throw makeCodedTypeError('MessagePort cannot be constructed directly', 'ERR_CONSTRUCT_CALL_INVALID');
        }

        class MessagePortImpl extends MessagePortEventTarget {
            constructor() {
                if (!constructingMessagePort) {
                    throw makeCodedTypeError('MessagePort cannot be constructed directly', 'ERR_CONSTRUCT_CALL_INVALID');
                }
                super();
            }

            postMessage(message, options) {
                if (this._closed || !this._peer || this._peer._closed) return;
                const transferList = transferListFrom(options);
                const cloned = cloneMessageForDelivery(message, transferList);
                enqueuePortMessage(this._peer, cloned, transferList.filter((item) => item instanceof MessagePort));
            }

            start() { schedulePortFlush(this); }

            close(callback) { closePortPair(this, callback); }

            ref() { if (!this._closed) this._refed = true; return this; }
            unref() { if (!this._closed) this._refed = false; return this; }
            hasRef() { return this._closed ? false : this._refed; }

            get onmessage() { return this._onmessage || null; }
            set onmessage(listener) {
                this._onmessage = listener;
                if (typeof listener === 'function') {
                    this.ref();
                    schedulePortFlush(this);
                }
            }

            get onmessageerror() { return this._onmessageerror || null; }
            set onmessageerror(listener) { this._onmessageerror = listener; }
        }

        let constructingMessagePort = false;
        MessagePort.prototype = MessagePortImpl.prototype;
        Object.defineProperty(MessagePort.prototype, 'constructor', {
            value: MessagePort,
            writable: true,
            configurable: true,
        });

        function enqueuePortMessage(port, message, ports) {
            if (port._closed) return;
            port._queue.push({ message, ports: ports || [] });
            schedulePortFlush(port);
        }

        function schedulePortFlush(port) {
            if (port._scheduled) return;
            port._scheduled = true;
            defer(() => {
                port._scheduled = false;
                flushPortMessages(port);
            });
        }

        function hasPortMessageHandler(port) {
            return typeof port._onmessage === 'function' ||
                port.listenerCount('message') > 0 ||
                (port._eventListeners.get('message') || new Set()).size > 0;
        }

        function flushPortMessages(port) {
            while (!port._closed && port._queue.length > 0 && hasPortMessageHandler(port)) {
                const entry = port._queue.shift();
                const event = makeMessageEvent('message', entry.message, port, entry.ports);
                if (typeof port._onmessage === 'function') port._onmessage.call(port, event);
                if (port.listenerCount('message') > 0) EventEmitter.prototype.emit.call(port, 'message', entry.message);
                const listeners = Array.from(port._eventListeners.get('message') || []);
                for (const listener of listeners) invokeEventListener(listener, port, event);
            }
        }

        function closePortPair(port, callback) {
            if (typeof callback === 'function') port.once('close', callback);
            if (port._closing || port._closed) return;
            port._closing = true;
            const peer = port._peer;
            if (peer && !peer._closing) peer._closing = true;
            defer(() => {
                closePort(port);
                if (peer) closePort(peer);
            });
        }

        function closePort(port) {
            if (!port || port._closed) return;
            port._closed = true;
            port._refed = false;
            port._queue.length = 0;
            port.emit('close');
            destroyAsyncResource(port);
        }

        function MessageChannel() {
            if (!new.target) {
                throw makeCodedTypeError('Class constructor MessageChannel cannot be invoked without new', 'ERR_CONSTRUCT_CALL_REQUIRED');
            }
            constructingMessagePort = true;
            try {
                this.port1 = new MessagePortImpl();
                this.port2 = new MessagePortImpl();
            } finally {
                constructingMessagePort = false;
            }
            this.port1._peer = this.port2;
            this.port2._peer = this.port1;
        }

        function getBroadcastState(channel) {
            if (!(channel instanceof BroadcastChannel) || !channel._bcState) throw invalidThis('BroadcastChannel');
            return channel._bcState;
        }

        class BroadcastChannel extends EventEmitter {
            constructor(name) {
                if (arguments.length === 0) {
                    throw new TypeError('The "name" argument must be specified');
                }
                if (typeof name === 'symbol') {
                    throw new TypeError('Cannot convert a Symbol value to a string');
                }
                super();
                const stringName = String(name);
                this._eventListeners = new Map();
                this._queue = [];
                this._scheduled = false;
                this._bcState = { name: stringName, closed: false, refed: true };
                if (!broadcastChannels.has(stringName)) broadcastChannels.set(stringName, []);
                broadcastChannels.get(stringName).push(this);
            }

            get name() { return getBroadcastState(this).name; }

            postMessage(message) {
                const state = getBroadcastState(this);
                if (state.closed) throw new Error('BroadcastChannel is closed');
                if (arguments.length === 0) throw new TypeError('The "message" argument must be specified');
                assertBroadcastCloneable(message);
                const peers = (broadcastChannels.get(state.name) || []).slice();
                for (const peer of peers) {
                    if (peer === this) continue;
                    const peerState = getBroadcastState(peer);
                    if (peerState.closed) continue;
                    peer._queue.push({ message, ports: [] });
                    peer._scheduleFlush();
                }
            }

            _scheduleFlush() {
                if (this._scheduled) return;
                this._scheduled = true;
                defer(() => {
                    this._scheduled = false;
                    this._flushMessages();
                });
            }

            _hasMessageHandler() {
                return typeof this.onmessage === 'function' ||
                    this.listenerCount('message') > 0 ||
                    (this._eventListeners.get('message') || new Set()).size > 0;
            }

            _flushMessages() {
                const state = getBroadcastState(this);
                while (!state.closed && this._queue.length > 0 && this._hasMessageHandler()) {
                    const entry = this._queue.shift();
                    const event = makeMessageEvent('message', entry.message, this, entry.ports);
                    if (typeof this.onmessage === 'function') this.onmessage.call(this, event);
                    if (this.listenerCount('message') > 0) this.emit('message', entry.message);
                    const listeners = Array.from(this._eventListeners.get('message') || []);
                    for (const listener of listeners) invokeEventListener(listener, this, event);
                }
            }

            on(event, listener) {
                const ret = super.on(event, listener);
                if (event === 'message') this._scheduleFlush();
                return ret;
            }

            once(event, listener) {
                const ret = super.once(event, listener);
                if (event === 'message') this._scheduleFlush();
                return ret;
            }

            addEventListener(type, listener) {
                getBroadcastState(this);
                if (!this._eventListeners.has(type)) this._eventListeners.set(type, new Set());
                this._eventListeners.get(type).add(listener);
                if (type === 'message') this._scheduleFlush();
            }

            removeEventListener(type, listener) {
                getBroadcastState(this);
                const listeners = this._eventListeners.get(type);
                if (listeners) listeners.delete(listener);
            }

            dispatchEvent(event) {
                getBroadcastState(this);
                const listeners = Array.from(this._eventListeners.get(event.type) || []);
                for (const listener of listeners) invokeEventListener(listener, this, event);
                return !event.defaultPrevented;
            }

            close() {
                const state = getBroadcastState(this);
                if (state.closed) return;
                state.closed = true;
                state.refed = false;
                this._queue.length = 0;
                const peers = broadcastChannels.get(state.name);
                if (peers) {
                    const index = peers.indexOf(this);
                    if (index !== -1) peers.splice(index, 1);
                    if (peers.length === 0) broadcastChannels.delete(state.name);
                }
            }

            ref() { getBroadcastState(this).refed = true; return this; }
            unref() { getBroadcastState(this).refed = false; return this; }
            hasRef() { return getBroadcastState(this).refed; }

            [inspectCustom](depth) {
                const state = getBroadcastState(this);
                if (depth !== null && depth < 0) return 'BroadcastChannel';
                return `BroadcastChannel { name: '${state.name}', active: ${!state.closed} }`;
            }
        }

        Object.defineProperty(BroadcastChannel.prototype, 'onmessage', {
            configurable: true,
            enumerable: true,
            get() { return this._onmessage || null; },
            set(listener) {
                getBroadcastState(this);
                this._onmessage = listener;
                if (typeof listener === 'function') this._scheduleFlush();
            },
        });

        function receiveMessageOnPort(port) {
            if (!(port instanceof MessagePort) && !(port instanceof BroadcastChannel)) throw invalidPortArg();
            const entry = port._queue.shift();
            return entry ? { message: entry.message } : undefined;
        }

        function moveMessagePortToContext(port) {
            if (!(port instanceof MessagePort)) throw invalidPortArg();
            return port;
        }

        function markAsUntransferable(value) {
            if (isObject(value)) markedUntransferable.add(value);
        }

        function isMarkedAsUntransferable(value) {
            return isObject(value) && markedUntransferable.has(value);
        }

        function clearSharedWorkerData() {
            if (typeof setSharedObject === 'function') {
                try { setSharedObject(null); } catch {}
            }
        }
        function joinShellWorkers() {
            if (typeof joinWorkerThreads === 'function') {
                try { joinWorkerThreads(); } catch {}
            }
        }
        class Worker extends EventEmitter {
            constructor(filenameOrSource, options) {
                super();
                options = options || {};
                this.threadId = nextThreadId++;
                this.resourceLimits = options.resourceLimits ? { ...options.resourceLimits } : {};
                this._workerRefed = true;
                this._workerExited = false;
                this._workerDestroyed = false;
                this._kandeloAsyncResource = createAsyncResource('WORKER', this);
                let source = String(filenameOrSource);
                if (!options.eval) {
                    const loaded = std.loadFile(source);
                    if (loaded == null) throw new Error('Cannot find module ' + source);
                    source = loaded;
                }

                let workerDataExpression = 'undefined';
                if (Object.prototype.hasOwnProperty.call(options, 'workerData')) {
                    const data = options.workerData;
                    assertCloneableForPort(data, Array.isArray(options.transferList) ? options.transferList : []);
                    if (data instanceof SharedArrayBuffer ||
                        (typeof WebAssembly === 'object' && WebAssembly.Memory && data instanceof WebAssembly.Memory)) {
                        if (typeof setSharedObject !== 'function') {
                            throw new Error('SpiderMonkey shared worker mailbox is unavailable');
                        }
                        setSharedObject(data);
                        workerDataExpression = 'getSharedObject()';
                    } else {
                        try {
                            workerDataExpression = JSON.stringify(data);
                        } catch {
                            workerDataExpression = 'undefined';
                        }
                    }
                } else if (typeof setSharedObject === 'function') {
                    setSharedObject(null);
                }

                const prelude = [
                    'Object.defineProperty(globalThis, "workerData", { value: ' + workerDataExpression + ', configurable: true, writable: true });',
                    'Object.defineProperty(globalThis, "parentPort", { value: null, configurable: true, writable: true });',
                    'var __kandeloAsyncHooks = {',
                    '  AsyncResource: class AsyncResource { runInAsyncScope(fn, thisArg, ...args) { return fn.apply(thisArg, args); } emitDestroy() { return this; } asyncId() { return 0; } triggerAsyncId() { return 0; } bind(fn) { return fn; } static bind(fn) { return fn; } },',
                    '  AsyncLocalStorage: class AsyncLocalStorage { run(store, fn, ...args) { this._store = store; try { return fn(...args); } finally { this._store = undefined; } } getStore() { return this._store; } enterWith(store) { this._store = store; } disable() { this._store = undefined; } },',
                    '  createHook: function() { return { enable() { return this; }, disable() { return this; } }; },',
                    '  executionAsyncId: function() { return 0; },',
                    '  triggerAsyncId: function() { return 0; },',
                    '  executionAsyncResource: function() { return {}; }',
                    '};',
                    'var require = function(name) {',
                    '  if (name === "worker_threads" || name === "node:worker_threads") {',
                    '    return { isMainThread: false, parentPort: parentPort, workerData: workerData };',
                    '  }',
                    '  if (name === "async_hooks" || name === "node:async_hooks") return __kandeloAsyncHooks;',
                    '  throw new Error("Cannot find module " + name);',
                    '};',
                    'var module = { exports: {} };',
                    'var exports = module.exports;',
                ].join('\n');

                if (typeof evalInWorker !== 'function') {
                    throw new Error('SpiderMonkey evalInWorker is unavailable');
                }
                evalInWorker(prelude + '\n(function(){\n' + source + '\n})();\n');
                const defer = typeof queueMicrotask === 'function'
                    ? queueMicrotask
                    : (fn) => Promise.resolve().then(fn);
                defer(() => {
                    this.emit('online');
                    this._emitExit(0);
                });
            }
            postMessage() {
                throw unsupportedWorkerMessageApi('Worker.postMessage');
            }
            terminate() {
                clearSharedWorkerData();
                joinShellWorkers();
                this.resourceLimits = {};
                this._emitExit(0);
                return Promise.resolve(0);
            }
            _emitExit(code) {
                if (this._workerExited) return;
                this._workerExited = true;
                this.emit('exit', code);
                defer(() => {
                    this._workerDestroyed = true;
                    destroyAsyncResource(this);
                });
            }
            ref() { if (!this._workerDestroyed) this._workerRefed = true; return this; }
            unref() { if (!this._workerDestroyed) this._workerRefed = false; return this; }
            hasRef() { return this._workerDestroyed ? undefined : this._workerRefed; }
        }
        if (typeof globalThis.MessagePort === 'undefined') defineAdapterGlobal('MessagePort', MessagePort);
        if (typeof globalThis.MessageChannel === 'undefined') defineAdapterGlobal('MessageChannel', MessageChannel);
        if (typeof globalThis.BroadcastChannel === 'undefined') defineAdapterGlobal('BroadcastChannel', BroadcastChannel);
        return {
            isMainThread: true,
            parentPort: null,
            workerData: null,
            resourceLimits: {},
            Worker,
            MessageChannel,
            MessagePort,
            BroadcastChannel,
            receiveMessageOnPort,
            moveMessagePortToContext,
            markAsUntransferable,
            isMarkedAsUntransferable,
            SHARE_ENV: Symbol.for('kandelo.worker_threads.SHARE_ENV'),
        };
    });

    const native = globalThis.__kandeloNodeNative || {};
    const _nodeNative = {
        evalScriptAsFunction(source, filename) {
            if (typeof native.evalScriptAsFunction === 'function') {
                return native.evalScriptAsFunction(source, filename);
            }
            return (0, eval)(source + '\n//# sourceURL=' + filename);
        },
        decodeUtf8(bytes) { return decodeUtf8(bytes); },
        jsonParse(text) { return nativeJsonParse(text); },
        setRawMode(fd, raw) { if (typeof native.setRawMode === 'function') return native.setRawMode(fd, raw); },
        createHash(algorithm) { return native.createHash(algorithm); },
        createHmac(algorithm, key) { return native.createHmac(algorithm, key); },
        createDeflate(level) { return native.createDeflate(level); },
        createInflate() { return native.createInflate(); },
        createGzip(level) { return native.createGzip(level); },
        createGunzip() { return native.createGunzip(); },
        deflateSync(input, level) { return native.deflateSync(input, level); },
        inflateSync(input) { return native.inflateSync(input); },
        gzipSync(input, level) { return native.gzipSync(input, level); },
        gunzipSync(input) { return native.gunzipSync(input); },
        socketConnect(host, port) { return native.socketConnect(host, port); },
        socketRead(fd, length) { return native.socketRead(fd, length); },
        socketWrite(fd, bytes) { return native.socketWrite(fd, bytes); },
        socketClose(fd) { return native.socketClose(fd); },
        tlsConnect(fd, servername, options) { return native.tlsConnect(fd, servername, options); },
        tlsRead(handle, length) { return native.tlsRead(handle, length); },
        tlsWrite(handle, bytes) { return native.tlsWrite(handle, bytes); },
        tlsClose(handle) { return native.tlsClose(handle); },
    };

    const entryPath = typeof scriptPath === 'string' && scriptPath ? scriptPath : '';
    const args = typeof scriptArgs !== 'undefined' ? Array.from(scriptArgs) : [];
    if (!entryPath && args.length > 0) {
        const firstArg = String(args[0]);
        const base = firstArg.slice(firstArg.lastIndexOf('/') + 1);
        if (base === 'node' || base === 'node.wasm' ||
            base === 'spidermonkey-node' || base === 'spidermonkey-node.wasm') {
            args.shift();
        }
    }
    defineAdapterGlobal('argv0', 'node');
    defineAdapterGlobal('execArgv', entryPath ? ['node', entryPath, ...args] : ['node', ...args]);
