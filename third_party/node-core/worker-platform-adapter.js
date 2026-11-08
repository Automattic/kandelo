// Worker objects own actual engine threads and entangled native endpoints.
// Complete option/profiling/stdio/fd/transfer semantics remain separate work.
function _createNodeWorkerPlatform(platform) {
    'use strict';
    const P = _createNodePrimordials();
    const { SafeMap, SafeSet, SafeWeakMap, ObjectAssign, ObjectEntries, ObjectCreate, ArrayPrototypeMap, ArrayPrototypeForEach,
        ObjectKeys, ObjectDefineProperty, ObjectGetOwnPropertyNames, ObjectFreeze, ArrayIsArray, ArrayPrototypeSlice, Promise, ReflectApply, String, SymbolFor } = P;
    const { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_WORKER_PATH, ERR_WORKER_INVALID_EXEC_ARGV } = platform.values.errors.codes;
    const { validateArray, validateString } = platform.values.validators;
    const environment = platform.environment;
    // Factory initialization precedes user LOAD/main execution. Capture only
    // the actual native CLI data schema now; later public argv/prototype
    // mutation cannot turn early metadata into a second user host graph.
    const startupCLI = ObjectCreate(null);
    for (const key of ObjectGetOwnPropertyNames(platform.cliOptions || {})) {
        if (key === 'evalSource') continue;
        const value = platform.cliOptions[key];
        if (ArrayIsArray(value)) {
            const copy = ArrayPrototypeSlice(value);
            for (const item of copy) if (typeof item !== 'string')
                throw new platform.values.errors.codes.ERR_INVALID_STATE('Native Worker CLI array is not string data');
            startupCLI[key] = ObjectFreeze(copy);
        } else {
            if (value !== null && typeof value === 'object' || typeof value === 'function' || typeof value === 'symbol')
                throw new platform.values.errors.codes.ERR_INVALID_STATE('Native Worker CLI metadata is not primitive data');
            startupCLI[key] = value;
        }
    }
    ObjectFreeze(startupCLI);
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
            // Pinned internal/worker.js captures/coerces argv before resolving
            // filename or reading environment/options. Preserve observable
            // getter/coercion order and retain the one mapped startup value.
            let argv;
            if (options.argv) {
                validateArray(options.argv, 'options.argv');
                argv = ArrayPrototypeMap(options.argv, String);
            }
            let source = '', path = '', doEval = false;
            if (options.eval) {
                if (typeof filename !== 'string') throw new ERR_INVALID_ARG_VALUE('options.eval', options.eval,
                    "must be false when 'filename' is not a string");
                source = filename;
                doEval = true;
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
            let sourceEnv, explicitEnvironment = false;
            // Match the pinned constructor's repeated env getter ordering.
            if (typeof options.env === 'object' && options.env !== null) {
                sourceEnv = options.env; explicitEnvironment = true;
            } else if (options.env == null) sourceEnv = platform.process.env;
            else if (options.env === SHARE_ENV) unavailable('shared environment store');
            else throw new ERR_INVALID_ARG_TYPE('options.env',
                ['object', 'undefined', 'null', 'worker_threads.SHARE_ENV'], options.env);
            const env = ObjectCreate(null);
            ArrayPrototypeForEach(ObjectEntries(sourceEnv), ({ 0: key, 1: value }) => {
                env[key] = `${value}`;
            });
            if (options.name !== undefined) unavailable('name ownership');
            // Native WorkerImpl receives this last getter value after env,
            // then resource limits/descriptor policy, before element coercion.
            const execArgv = options.execArgv;
            if (options.resourceLimits !== undefined) unavailable('resourceLimits ownership');
            if (options.trackUnmanagedFds !== undefined) unavailable('trackUnmanagedFds ownership');
            const parsed = operation('execArgv', execArgv, env, explicitEnvironment, startupCLI.execArgv);
            if (parsed.invalidExecArgv) throw new ERR_WORKER_INVALID_EXEC_ARGV(parsed.invalidExecArgv);
            if (parsed.invalidNodeOptions) throw new ERR_WORKER_INVALID_EXEC_ARGV(
                parsed.invalidNodeOptions, 'invalid NODE_OPTIONS env variable');
            // Parsed warning state/arguments are consumed by the actual child
            // warning/bootstrap owner, independently of public process.execArgv.
            const cliOptions = ObjectAssign(ObjectCreate(null), startupCLI);
            // Native CLI fields intentionally retain nonenumerable DATA
            // descriptors; enumerate their own names, not Object.assign keys.
            const parsedNames = ObjectGetOwnPropertyNames(parsed);
            for (let i = 0; i < parsedNames.length; i++) cliOptions[parsedNames[i]] = parsed[parsedNames[i]];
            if (options.stdin !== undefined) unavailable('stdin ownership');
            if (options.stdout !== undefined) unavailable('stdout ownership');
            if (options.stderr !== undefined) unavailable('stderr ownership');
            // The engine's bootstrap consumes an array-like startup value;
            // undefined means no user suffix, represented by an empty list.
            const bootstrap = platform.native.serializeMessage({ env, cliOptions }, []);
            // One graph/transfer registry owns all user LOAD values. Target
            // Finish runs transfer hosts, then argv clones, then data clones;
            // serializing config separately changes hooks/errors/AB commits.
            const load = { argv, filename: doEval ? source : path,
                doEval: doEval ? 'classic' : false, workerData: options.workerData, environmentData };
            const serialized = platform.native.serializeMessage(load, options.transferList || []);
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
    // Private imports consume real captured thread identity, independently of
    // public worker_threads assignment/shadowing. This view is never exported.
    const internal = { threadId: api.threadId };
    return { api, internal, dispatch,
        initializeData(data) {
            const startup = platform.initializeStartup(data);
            environmentData = new SafeMap(data.environmentData); api.workerData = data.workerData;
            return startup;
        } };
}
