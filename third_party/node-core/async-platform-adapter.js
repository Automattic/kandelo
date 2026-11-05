// Async context is stored by the embedding and captured by real promise jobs.
// Native lifecycle metadata belongs to actual engine promises/jobs. Owned
// timer and tick resources use the same ID allocator and dispatch registry.
function _createNodeAsyncPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const {
        ArrayFrom, ArrayPrototypePush, ArrayPrototypePop, Error, NumberIsSafeInteger,
        ObjectAssign, ObjectCreate, ObjectDefineProperty, ObjectFreeze,
        ObjectPrototypeHasOwnProperty, ReflectApply, SafeFinalizationRegistry,
        SafeMap, SafeSet, Symbol, TypeError, RangeError,
    } = primordials;
    const kEmptyObject = ObjectFreeze(ObjectCreate(null));
    const root = ObjectFreeze({ __proto__: null, frame: undefined, id: 0, triggerId: 0, resource: ObjectCreate(null) });
    let scopeDepth = 0;
    const stack = [];
    let hooks = new SafeSet(), pendingHooks, dispatchDepth = 0, hooksFatal = false;
    const state = () => platform.native.getAsyncContext() ?? root;
    const setState = value => platform.native.setAsyncContext(value);
    const frame = () => state().frame;
    const setFrame = value => setState(ObjectFreeze(ObjectAssign(ObjectCreate(null), state(), { frame: value })));
    function incomplete(message) {
        const error = new Error(message); error.code = 'ERR_NOT_IMPLEMENTED'; throw error;
    }
    function executionState() {
        if (scopeDepth === 0 && state().untrackedTask) {
            incomplete('Native async execution IDs and resources are not implemented');
        }
        return state();
    }
    const callbacks = new primordials.SafeWeakMap();
    function emit(kind, args, isPromise = false) {
        if (hooksFatal) return;
        dispatchDepth++;
        try {
            for (const hook of hooks) {
                const selected = callbacks.get(hook);
                if (isPromise && !selected.trackPromises) continue;
                const callback = selected[kind];
                if (callback !== undefined) {
                    try { ReflectApply(callback, hook, args); }
                    catch (error) { hooksFatal = true; platform.native.asyncHookFatal(error); }
                }
            }
        } finally {
            if (--dispatchDepth === 0 && pendingHooks !== undefined) {
                hooks = pendingHooks; pendingHooks = undefined;
                platform.native.setAsyncDestroyTracking(hookExists('destroy'));
            }
        }
    }
    function hookExists(kind) {
        for (const hook of hooks) if (callbacks.get(hook)[kind] !== undefined) return true;
        return false;
    }
    function enabledHooksExist() {
        return hookExists('init') || hookExists('before') || hookExists('after') || hookExists('destroy') || hookExists('promiseResolve');
    }
    function modifyHook(hook, enable) {
        if (dispatchDepth && pendingHooks === undefined) pendingHooks = new SafeSet(hooks);
        const selected = pendingHooks ?? hooks;
        if (enable) selected.add(hook); else selected.delete(hook);
        if (!dispatchDepth) platform.native.setAsyncDestroyTracking(hookExists('destroy'));
    }
    const { codes } = platform.values.errors;
    class AsyncHook {
        constructor({ init, before, after, destroy, promiseResolve, trackPromises = true }) {
            const selected = { init, before, after, destroy, promiseResolve, trackPromises };
            for (const key of ['init', 'before', 'after', 'destroy', 'promiseResolve']) {
                if (selected[key] !== undefined && typeof selected[key] !== 'function') throw new codes.ERR_ASYNC_CALLBACK('hook.' + key);
            }
            platform.values.validators.validateBoolean(trackPromises, 'trackPromises');
            if (trackPromises === false && promiseResolve) {
                throw new codes.ERR_INVALID_ARG_VALUE('trackPromises', trackPromises,
                    'must not be false when promiseResolve is enabled');
            }
            callbacks.set(this, selected);
        }
        enable() {
            modifyHook(this, true); return this;
        }
        disable() { modifyHook(this, false); return this; }
    }
    const async_id_symbol = Symbol('async_id_symbol');
    const trigger_async_id_symbol = Symbol('trigger_async_id_symbol');
    const async_context_frame = Symbol('async_context_frame');
    const owner_symbol = Symbol('owner_symbol');
    const AsyncContextFrameModule = {
        getContinuationPreservedEmbedderData: frame,
        setContinuationPreservedEmbedderData: setFrame,
    };
    const tickQueue = [];
    let tickCursor = 0;
    const finalizers = new SafeFinalizationRegistry(({ asyncId, destroyed, isPromise }) => {
        if (!destroyed.destroyed) emitDestroy(asyncId, isPromise);
    });
    function emitDestroy(asyncId, isPromise = false) {
        if (!hookExists('destroy')) return;
        // Native lifecycle notifications do not allocate a TickObject or a
        // Promise merely to deliver their own destroy event.
        // One owning native queue preserves enqueue order across native GC,
        // explicit JS retirement and Promise finalization notifications.
        platform.native.enqueueAsyncDestroyId(asyncId, isPromise);
    }
    function drainDestroys() {
        const pending = platform.native.drainNativeAsyncDestroyIds();
        const prior = platform.native.getAsyncContext();
        setState(root);
        try {
            for (let i = 0; i < pending.length; ++i) emit('destroy', [pending[i][0]], pending[i][1]);
        }
        finally { setState(prior); }
        return pending.length;
    }
    function runInternalImmediate(fn) {
        // Node's native-immediate batch owns a fresh plain object with IDs 0/0.
        // InternalCallbackScope skips AsyncWrap hooks for ID zero; a public
        // timer here would manufacture an extra Immediate lifecycle.
        const prior = platform.native.getAsyncContext();
        setState(ObjectFreeze({ __proto__: null, frame: undefined,
            id: 0, triggerId: 0, resource: {} }));
        try { return ReflectApply(fn, undefined, []); }
        finally { setState(prior); }
    }
    function emitBefore(asyncId, triggerId, resource) {
        ArrayPrototypePush(stack, state());
        scopeDepth++;
        setState(ObjectFreeze({ __proto__: null, frame: frame(), id: asyncId, triggerId, resource }));
        try { emit('before', [asyncId]); }
        catch (error) {
            scopeDepth--; setState(ArrayPrototypePop(stack)); throw error;
        }
    }
    function emitAfter(asyncId) {
        try { emit('after', [asyncId]); }
        finally {
            const prior = ArrayPrototypePop(stack);
            scopeDepth--; setState(prior);
        }
    }
    const validators = platform.values.validators;
    const modules = new SafeMap([
        ['internal/util', { kEmptyObject }],
        ['internal/errors', platform.values.errors],
        ['internal/validators', validators],
        // The pinned default is enabled (node_options.h). This is a real
        // native-frame implementation; unsupported CLI overrides stay gaps.
        ['internal/options', { getOptionValue(name) {
            if (name === '--async-context-frame') return true;
            incomplete('Unimplemented async-platform option: ' + name);
        } }],
    ]);
    const factories = {
        /* NODE_ASYNC_MODULES */
    };
    const loading = new SafeMap();
    function require(name) {
        if (loading.has(name)) return loading.get(name).exports;
        if (modules.has(name)) return modules.get(name);
        if (!ObjectPrototypeHasOwnProperty(factories, name)) throw new Error('Unsupported Node async dependency: ' + name);
        const module = { exports: {} };
        loading.set(name, module);
        modules.set(name, module.exports);
        try { factories[name](module, module.exports, require, primordials, internalBinding); }
        catch (error) { modules.delete(name); loading.delete(name); throw error; }
        modules.set(name, module.exports);
        loading.delete(name);
        return module.exports;
    }
    function internalBinding(name) {
        if (name === 'async_context_frame') return AsyncContextFrameModule;
        throw new Error('Unsupported Node async binding: ' + name);
    }
    const AsyncContextFrame = require('internal/async_context_frame');
    // Install the active implementations before AsyncResource can capture one.
    if (!AsyncContextFrame.enabled) incomplete('Async context frames are not enabled');
    const {
        ArrayPrototypeUnshift, FunctionPrototypeBind, ObjectDefineProperties,
    } = primordials;
    const validateString = validators.validateString;
    const validateFunction = validators.validateFunction;
    const ERR_INVALID_ASYNC_ID = codes.ERR_INVALID_ASYNC_ID;
    const ERR_ASYNC_TYPE = codes.ERR_ASYNC_TYPE;
    const getDefaultTriggerAsyncId = () => executionState().id;
    const newAsyncId = () => platform.native.allocateAsyncId();
    const initHooksExist = () => hookExists('init');
    const destroyHooksExist = () => hookExists('destroy');
    const emitInit = (id, type, triggerId, resource) => emit('init', [id, type, triggerId, resource]);
    const hasAsyncIdStack = () => stack.length > 0;
    const registerDestroyHook = (resource, asyncId, destroyed) => finalizers.register(resource, { asyncId, destroyed });
    /* NODE_ASYNC_RESOURCE */
    const nativeResources = new primordials.SafeWeakMap();
    const tasks = new primordials.SafeWeakMap();
    function nativeResource(resource) {
        let record = nativeResources.get(resource);
        if (record === undefined) {
            const info = platform.native.getAsyncResourceInfo(resource);
            const id = info[0], triggerId = info[1];
            const nativeType = ObjectPrototypeHasOwnProperty(info, 3) ? info[3] : undefined;
            record = { id, triggerId, nativeType, isPromise: platform.native.isPromise(resource) };
            nativeResources.set(resource, record);
            if (nativeType === undefined && destroyHooksExist()) {
                finalizers.register(resource, { asyncId: id, destroyed: { destroyed: false }, isPromise: record.isPromise });
            }
        }
        return record;
    }
    function lifecycle(kind, resource, capturedFrame) {
        const record = nativeResource(resource);
        if (kind === 'promise:init' || kind === 'task:init' || kind === 'native:init') {
            emit('init', [record.id, record.nativeType ?? (record.isPromise ? 'PROMISE' : 'Microtask'), record.triggerId, resource], record.isPromise);
        } else if (kind === 'promise:resolve') {
            emit('promiseResolve', [record.id], true);
        } else if (kind === 'before') {
            setState(ObjectFreeze({ __proto__: null, frame: capturedFrame,
                id: record.id, triggerId: record.triggerId, resource }));
            emit('before', [record.id], record.isPromise);
        } else if (kind === 'after') {
            emit('after', [record.id], record.isPromise);
        } else incomplete('Unknown native async lifecycle event: ' + kind);
    }
    function createTask(resource, type, id = newAsyncId(), triggerId = executionState().id) {
        const record = { id, triggerId, frame: frame(), resource, destroyed: false };
        tasks.set(resource, record);
        resource[async_id_symbol] = id;
        resource[trigger_async_id_symbol] = triggerId;
        emit('init', [record.id, type, record.triggerId, resource]);
        return record;
    }
    function retireTask(resource) {
        const record = tasks.get(resource);
        if (record !== undefined && !record.destroyed) {
            record.destroyed = true; record.frame = undefined;
            emitDestroy(record.id);
        }
    }
    function runTask(resource, fn, receiver, args) {
        const record = tasks.get(resource);
        if (record === undefined || record.destroyed) incomplete('Async callback has no live owning resource');
        const prior = platform.native.getAsyncContext();
        setFrame(record.frame);
        try {
            emitBefore(record.id, record.triggerId, resource);
            let completed = false;
            try {
                const result = ReflectApply(fn, receiver, args);
                completed = true; return result;
            } finally {
                if (completed) emitAfter(record.id);
                else { scopeDepth--; setState(ArrayPrototypePop(stack)); }
            }
        } finally { setState(prior); }
    }
    /* NODE_TICK_OBJECT */
    function enqueueTick(fn, ...args) {
        validateFunction(fn, 'callback');
        if (platform.process._exiting) return;
        const id = newAsyncId(), triggerId = executionState().id;
        const resource = new TickObject(fn, args.length ? args : undefined, id, triggerId);
        createTask(resource, 'TickObject', id, triggerId);
        ArrayPrototypePush(tickQueue, resource);
    }
    function drainTicks() {
        let count = 0;
        try {
            while (tickCursor < tickQueue.length) {
                const resource = tickQueue[tickCursor]; tickQueue[tickCursor++] = undefined;
                try { runTask(resource, resource.callback, undefined, resource.args || []); }
                finally { retireTask(resource); resource[async_context_frame] = undefined; }
                count++;
            }
        } finally {
            if (tickCursor === tickQueue.length) { tickCursor = 0; tickQueue.length = 0; }
        }
        return count;
    }
    platform.native.setAsyncLifecycle(lifecycle);
    platform.native.setAsyncDestroyTracking(false);
    const api = {
        AsyncResource,
        createHook: callbacks => new AsyncHook(callbacks),
        executionAsyncId: () => executionState().id,
        triggerAsyncId: () => executionState().triggerId,
        executionAsyncResource: () => executionState().resource,
        // This is the declared provider-ID enumeration, not a claim that every
        // corresponding resource owner is implemented or can be instantiated.
        asyncWrapProviders: ObjectFreeze(ObjectAssign(ObjectCreate(null), {
            /* NODE_ASYNC_PROVIDER_MAP */
        })),
    };
    modules.set('async_hooks', api);
    ObjectDefineProperty(api, 'AsyncLocalStorage', {
        configurable: true, enumerable: true,
        get: () => require('internal/async_local_storage/async_context_frame'),
    });
    return { api, validators, frame: AsyncContextFrame, enabledHooksExist,
        symbols: { owner_symbol, async_id_symbol, trigger_async_id_symbol },
        createTask, runTask, retireTask, enqueueTick, drainTicks, drainDestroys, runInternalImmediate,
        hasTicks: () => tickCursor < tickQueue.length,
    };
}

// Keep the pinned lazy public class bound to the actual emitter and resource
// implementations. It does not create a second event or context registry.
function _createNodeEventEmitterAsyncResourceGetter(EventEmitter, platform) {
    const { ArrayPrototypeUnshift, ReflectApply } = _createNodePrimordials();
    const require = name => {
        if (name === 'async_hooks') return platform.api;
        throw new Error('Unsupported EventEmitter async resource dependency: ' + name);
    };
    const validateString = platform.validators.validateString;
    /* NODE_EVENT_EMITTER_ASYNC_RESOURCE */
    return lazyEventEmitterAsyncResource;
}
