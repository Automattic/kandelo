// Worker objects own actual engine threads and entangled native endpoints.
// Complete option/profiling/stdio/fd/transfer semantics remain separate work.
function _createNodeWorkerPlatform(platform) {
    'use strict';
    const P = _createNodePrimordials();
    const { SafeMap, SafeSet, SafeWeakMap, ObjectAssign, ObjectEntries, ObjectCreate, ArrayPrototypeMap,
        ObjectKeys, ObjectDefineProperty, ObjectGetOwnPropertyNames, Promise, ReflectApply, String, SymbolFor } = P;
    const { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_WORKER_PATH } = platform.values.errors.codes;
    const { validateArray, validateString } = platform.values.validators;
    const environment = platform.environment;
    const workerStates = new SafeWeakMap(), live = new SafeSet();
    let environmentData = new SafeMap();
    const SHARE_ENV = SymbolFor('nodejs.worker_threads.SHARE_ENV');
    const operation = (...args) => platform.native.worker(...args);
    function unavailable(name) {
        const error = new P.Error('Worker feature is not implemented: ' + name);
        error.code = 'ERR_NOT_IMPLEMENTED'; throw error;
    }
    function getEnvironmentData(key) { return environmentData.get(key); }
    function setEnvironmentData(key, value) {
        if (value === undefined) environmentData.delete(key);
        else environmentData.set(key, value);
    }
    const parentPort = environment ? platform.ports.adopt(environment.parentHandle) : null;
    class Worker extends platform.EventEmitter {
        constructor(filename, options = ObjectCreate(null)) {
            super();
            if (options.execArgv) validateArray(options.execArgv, 'options.execArgv');
            if (options.argv) validateArray(options.argv, 'options.argv');
            let source = '', path = '';
            if (options.eval) {
                if (typeof filename !== 'string') throw new ERR_INVALID_ARG_VALUE('options.eval', options.eval,
                    "must be false when 'filename' is not a string");
                source = filename;
            } else {
                if (platform.isURL(filename)) {
                    if (filename.protocol !== 'file:') unavailable('data URL worker loader');
                    path = platform.url.fileURLToPath(filename);
                } else if (typeof filename !== 'string') {
                    throw new ERR_INVALID_ARG_TYPE('filename', ['string', 'URL'], filename);
                } else {
                    if (!platform.path.isAbsolute(filename) && !/^\.\.?[\\/]/.test(filename)) throw new ERR_WORKER_PATH(filename);
                    path = platform.path.resolve(filename);
                }
            }
            for (const name of ['stdin', 'stdout', 'stderr', 'resourceLimits', 'execArgv', 'name', 'trackUnmanagedFds']) {
                if (options[name] !== undefined) unavailable(name + ' ownership');
            }
            if (options.env === SHARE_ENV) unavailable('shared environment store');
            if (options.env != null && typeof options.env !== 'object')
                throw new ERR_INVALID_ARG_TYPE('options.env', ['object', 'undefined', 'null', 'worker_threads.SHARE_ENV'], options.env);
            const env = ObjectCreate(null);
            for (const [key, value] of ObjectEntries(options.env == null ? platform.process.env : options.env)) env[key] = `${value}`;
            const argv = options.argv ? ArrayPrototypeMap(options.argv, String) : [];
            const cliOptions = ObjectCreate(null);
            for (const key of ObjectGetOwnPropertyNames(platform.cliOptions || {})) cliOptions[key] = platform.cliOptions[key];
            cliOptions.evalSource = options.eval ? source : '';
            const config = { source, path, eval: !!options.eval, argv, env, cliOptions };
            const bootstrap = platform.native.serializeMessage(config, []);
            const serialized = platform.native.serializeMessage({ environmentData, workerData: options.workerData }, options.transferList || []);
            const launched = operation('create', serialized, bootstrap);
            let port;
            try {
                port = platform.ports.adopt(launched.port);
                const state = { handle: launched.handle, port, threadId: launched.threadId, online: false, closed: false };
                workerStates.set(this, state);
                for (const event of ['message', 'messageerror']) port.on(event, value => this.emit(event, value));
                port.unref(); live.add(this);
            } catch (error) {
                operation('abandon', launched.handle);
                if (port) port.close();
                throw error;
            }
        }
        get threadId() { const state = workerStates.get(this); return state.closed ? -1 : state.threadId; }
        postMessage(...args) {
            const state = workerStates.get(this);
            if (!state.closed) ReflectApply(state.port.postMessage, state.port, args);
        }
        terminate() {
            const state = workerStates.get(this);
            this.ref();
            if (state.closed) return Promise.resolve();
            operation('stop', state.handle);
            return new Promise(resolve => this.once('exit', resolve));
        }
        async [Symbol.asyncDispose]() { await this.terminate(); }
        ref() { const state = workerStates.get(this); if (!state.closed) operation('ref', state.handle, true); return this; }
        unref() { const state = workerStates.get(this); if (!state.closed) operation('ref', state.handle, false); return this; }
    }
    function dispatch() {
        let count = 0;
        for (const worker of [...live]) {
            const state = workerStates.get(worker), status = operation('status', state.handle);
            if (status.ready && !state.online) { state.online = true; count++; worker.emit('online'); }
            if (!status.done) continue;
            // Real child teardown/join is already complete. Drain its queued
            // messages before publishing exit, then retire the exact owner.
            platform.ports.drain(state.port);
            let error;
            try {
                if (status.errorPacket) error = platform.native.deserializeMessage(status.errorPacket);
                else if (status.failure) { error = new P.Error(status.failure); error.code = 'ERR_WORKER_INIT_FAILED'; }
            }
            finally { state.closed = true; live.delete(worker); operation('release', state.handle); }
            count++;
            if (status.errorPacket || status.failure) worker.emit('error', error);
            worker.emit('exit', status.exitCode);
        }
        return count;
    }
    const api = { Worker, SHARE_ENV, parentPort, workerData: environment ? undefined : null,
        isMainThread: !environment, isInternalThread: false, threadId: environment ? environment.threadId : 0,
        getEnvironmentData, setEnvironmentData };
    return { api, dispatch,
        initializeData(data) { environmentData = new SafeMap(data.environmentData); api.workerData = data.workerData; } };
}
