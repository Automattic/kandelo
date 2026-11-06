// Async context is stored by the embedding and captured by real promise jobs.
// Native lifecycle metadata belongs to actual engine promises/jobs. Owned
// timer and tick resources use the same ID allocator and dispatch registry.
function _createNodeAsyncPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const {
        ArrayFrom, ArrayPrototypeIncludes, ArrayPrototypeIndexOf, ArrayPrototypePush,
        ArrayPrototypePop, ArrayPrototypeSlice, ArrayPrototypeSplice, Error, NumberIsSafeInteger,
        ObjectAssign, ObjectCreate, ObjectDefineProperty, ObjectFreeze,
        ObjectPrototypeHasOwnProperty, ReflectApply, SafeFinalizationRegistry,
        SafeMap, Symbol, TypeError, RangeError, Uint32Array,
    } = primordials;
    const kEmptyObject = ObjectFreeze(ObjectCreate(null));
    const root = ObjectFreeze({ __proto__: null, frame: undefined, id: 0, triggerId: 0, resource: {} });
    // The pinned public AsyncHook mutates these callback counts and arrays.
    // Only resource IDs/context and destroy delivery cross the native boundary.
    const kInit = 0, kBefore = 1, kAfter = 2, kDestroy = 3,
        kPromiseResolve = 4, kTotals = 5;
    const async_hook_fields = new Uint32Array(6);
    const active_hooks = { array: [], call_depth: 0, tmp_array: null, tmp_fields: null };
    const init_symbol = Symbol('init');
    const before_symbol = Symbol('before');
    const after_symbol = Symbol('after');
    const destroy_symbol = Symbol('destroy');
    const promise_resolve_symbol = Symbol('promiseResolve');
    const kNoPromiseHook = Symbol('kNoPromiseHook');
    let hooksFatal = false;
    const state = () => platform.native.getAsyncContext() ?? root;
    const setState = value => platform.native.setAsyncContext(value);
    const frame = () => state().frame;
    const setFrame = value => setState(ObjectFreeze(ObjectAssign(ObjectCreate(null), state(), { frame: value })));
    function incomplete(message) {
        const error = new Error(message); error.code = 'ERR_NOT_IMPLEMENTED'; throw error;
    }
    function executionState() {
        if (!platform.native.hasAsyncExecution() && state().untrackedTask) {
            incomplete('Native async execution IDs and resources are not implemented');
        }
        return state();
    }
    function getHookArrays() {
        if (active_hooks.call_depth === 0) return [active_hooks.array, async_hook_fields];
        if (active_hooks.tmp_array === null) {
            active_hooks.tmp_array = ArrayPrototypeSlice(active_hooks.array);
            active_hooks.tmp_fields = [];
            copyHooks(active_hooks.tmp_fields, async_hook_fields);
        }
        return [active_hooks.tmp_array, active_hooks.tmp_fields];
    }
    function copyHooks(destination, source) {
        destination[kInit] = source[kInit];
        destination[kBefore] = source[kBefore];
        destination[kAfter] = source[kAfter];
        destination[kDestroy] = source[kDestroy];
        destination[kPromiseResolve] = source[kPromiseResolve];
    }
    function syncDestroyTracking() {
        platform.native.setAsyncDestroyTracking(hookExists('destroy'));
    }
    // Promise mode installation/removal is an engine integration gap. These
    // entry points preserve public registry transitions without manufacturing
    // an activation state the actual engine does not implement.
    function enableHooks() { syncDestroyTracking(); }
    function disableHooks() { syncDestroyTracking(); }
    function updatePromiseHookMode() { syncDestroyTracking(); }
    function emit(kind, args, isPromise = false) {
        if (hooksFatal || !hookExists(kind)) return;
        const symbol = kind === 'init' ? init_symbol : kind === 'before' ? before_symbol :
            kind === 'after' ? after_symbol : kind === 'destroy' ? destroy_symbol : promise_resolve_symbol;
        active_hooks.call_depth++;
        try {
            for (let i = 0; i < active_hooks.array.length; i++) {
                const hook = active_hooks.array[i];
                if (typeof hook[symbol] === 'function') {
                    if (isPromise && hook[kNoPromiseHook]) continue;
                    ReflectApply(hook[symbol], hook, args);
                }
            }
        } catch (error) {
            hooksFatal = true;
            platform.native.asyncHookFatal(error);
        } finally {
            active_hooks.call_depth--;
        }
        if (active_hooks.call_depth === 0 && active_hooks.tmp_array !== null) {
            active_hooks.array = active_hooks.tmp_array;
            copyHooks(async_hook_fields, active_hooks.tmp_fields);
            active_hooks.tmp_array = null;
            active_hooks.tmp_fields = null;
            syncDestroyTracking();
        }
    }
    function hookExists(kind) {
        const index = kind === 'init' ? kInit : kind === 'before' ? kBefore :
            kind === 'after' ? kAfter : kind === 'destroy' ? kDestroy : kPromiseResolve;
        return async_hook_fields[index] > 0;
    }
    function enabledHooksExist() { return active_hooks.array.length > 0; }
    const { codes } = platform.values.errors;
    const { ERR_ASYNC_CALLBACK, ERR_INVALID_ARG_VALUE } = codes;
    const validateBoolean = platform.values.validators.validateBoolean;
    /* NODE_ASYNC_HOOK */
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
        if (!hookExists('destroy') || !(asyncId > 0)) return;
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
        const resource = {};
        const active = ObjectFreeze({ __proto__: null, frame: undefined,
            id: 0, triggerId: 0, resource });
        // This actual internal-immediate delivery owns a real plain resource,
        // default frame and IDs0/0. Updating JS metadata alone cannot override
        // the owning native execution stack used by the environment.
        platform.native.pushAsyncExecution(0, 0, resource, true);
        setState(active);
        let completed = false;
        try {
            const result = ReflectApply(fn, undefined, []);
            completed = true; return result;
        } finally {
            // A failed delivery keeps its execution owner/frame until the
            // outer native entry handles the exception. Recovery can clear
            // the stack while this call is active; never restore that snapshot.
            if (completed && platform.native.executionAsyncResource() === resource) {
                platform.native.popAsyncExecution(0); setState(prior);
            }
        }
    }
    function emitBefore(asyncId, triggerId, resource) {
        platform.native.pushAsyncExecution(asyncId, triggerId, resource, false);
        setState(ObjectFreeze({ __proto__: null, frame: frame(), id: asyncId, triggerId, resource }));
        emit('before', [asyncId]);
    }
    function emitAfter(asyncId) {
        try { emit('after', [asyncId]); }
        finally { setState(platform.native.popAsyncExecution(asyncId)); }
    }
    // Fatal recovery emits after hooks while the failing frame is still
    // installed. Its native scope owns final restoration/epoch invalidation.
    function emitRecoveredAfter(asyncId) {
        emit('after', [asyncId]);
        platform.native.popAsyncExecution(asyncId);
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
    const getDefaultTriggerAsyncId = () => {
        executionState();  // Preserve the existing untracked-resource guard.
        return platform.native.getDefaultTriggerAsyncId();
    };
    const newAsyncId = () => platform.native.allocateAsyncId();
    const initHooksExist = () => hookExists('init');
    const destroyHooksExist = () => hookExists('destroy');
    const emitInit = (id, type, triggerId, resource) => emit('init', [id, type, triggerId, resource]);
    const hasAsyncIdStack = () => platform.native.hasAsyncExecution();
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
        if (kind === 'callback:zero') {
            // Pinned InternalCallbackScope({0,0}) pushes its actual execution
            // resource/default frame without manufacturing an AsyncWrap ID.
            platform.native.pushAsyncExecution(0, 0, resource, true);
            setState(ObjectFreeze({ __proto__: null, frame: undefined,
                id: 0, triggerId: 0, resource }));
            return;
        }
        if (kind === 'callback:zero:after') {
            setState(platform.native.popAsyncExecution(0)); return;
        }
        const record = nativeResource(resource);
        if (kind === 'promise:init' || kind === 'task:init' || kind === 'native:init') {
            emit('init', [record.id, record.nativeType ?? (record.isPromise ? 'PROMISE' : 'Microtask'), record.triggerId, resource], record.isPromise);
        } else if (kind === 'promise:resolve') {
            emit('promiseResolve', [record.id], true);
        } else if (kind === 'before') {
            platform.native.pushAsyncExecution(record.id, record.triggerId, resource, true);
            setState(ObjectFreeze({ __proto__: null, frame: capturedFrame,
                id: record.id, triggerId: record.triggerId, resource }));
            emit('before', [record.id], record.isPromise);
        } else if (kind === 'after') {
            const enteringId = platform.native.executionAsyncId();
            emit('after', [enteringId], record.isPromise);
            setState(platform.native.popAsyncExecution(enteringId));
        } else incomplete('Unknown native async lifecycle event: ' + kind);
    }
    // The override belongs to the native environment, never a captured frame.
    function defaultTriggerAsyncIdScope(triggerId, block, ...args) {
        if (triggerId === undefined) return ReflectApply(block, null, args);
        const prior = platform.native.swapDefaultTriggerAsyncId(triggerId);
        try { return ReflectApply(block, null, args); }
        finally { platform.native.swapDefaultTriggerAsyncId(prior); }
    }
    function createTask(resource, type, id = newAsyncId(), triggerId = getDefaultTriggerAsyncId()) {
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
        emitBefore(record.id, record.triggerId, resource);
        let completed = false;
        try {
            const result = ReflectApply(fn, receiver, args);
            completed = true; return result;
        } finally {
            // On throw, the real entry/loop invokes the actual process handler
            // before retiring this stack. It must still see its IDs and frame.
            if (completed) { emitAfter(record.id); setState(prior); }
        }
    }
    /* NODE_TICK_OBJECT */
    function enqueueTick(fn, ...args) {
        validateFunction(fn, 'callback');
        if (platform.process._exiting) return;
        const id = newAsyncId(), triggerId = getDefaultTriggerAsyncId();
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
    function executionAsyncId() { executionState(); return platform.native.executionAsyncId(); }
    function triggerAsyncId() { executionState(); return platform.native.triggerAsyncId(); }
    function executionAsyncResource() { executionState(); return platform.native.executionAsyncResource() ?? root.resource; }
    const api = {
        get AsyncLocalStorage() {
            return require('internal/async_local_storage/async_context_frame');
        },
        createHook,
        executionAsyncId,
        triggerAsyncId,
        executionAsyncResource,
        // This is the declared provider-ID enumeration, not a claim that every
        // corresponding resource owner is implemented or can be instantiated.
        asyncWrapProviders: ObjectFreeze(ObjectAssign(ObjectCreate(null), {
            /* NODE_ASYNC_PROVIDER_MAP */
        })),
        AsyncResource,
    };
    modules.set('async_hooks', api);
    return { api, validators, frame: AsyncContextFrame, enabledHooksExist,
        symbols: { owner_symbol, async_id_symbol, trigger_async_id_symbol },
        createTask, runTask, retireTask, enqueueTick, drainTicks, drainDestroys, runInternalImmediate, defaultTriggerAsyncIdScope,
        hasTicks: () => tickCursor < tickQueue.length,
        uncaught: {
            executionAsyncId, hasAsyncIdStack,
            clearDefaultTriggerAsyncId: () => platform.native.swapDefaultTriggerAsyncId(-1),
            clearAsyncIdStack: () => platform.native.clearAsyncExecution(),
            afterHooksExist: () => hookExists('after'),
            emitAfter: emitRecoveredAfter,
            popAsyncContext: id => platform.native.popAsyncExecution(id),
        },
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
