// Dependencies for the pinned Node EventTarget and AbortController algorithms.
// This owns listener/cancellation state; it does not use host browser objects.
function _createNodeEventPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const {
        ArrayIsArray, ArrayPrototypeJoin, Error, NumberIsInteger, NumberIsNaN,
        NumberMAX_SAFE_INTEGER, NumberMIN_SAFE_INTEGER, ObjectAssign, ObjectCreate,
        ObjectDefineProperty, ObjectFreeze, ObjectGetOwnPropertyDescriptor,
        ObjectPrototypeHasOwnProperty, ReflectApply, SafeMap, String, Symbol,
        SymbolFor, TypeError, RangeError,
    } = primordials;
    const kEmptyObject = ObjectFreeze(ObjectCreate(null));
    const kEnumerableProperty = ObjectFreeze({ __proto__: null, enumerable: true });
    const types = _createNodeCoreTypes(platform.native);
    const inspect = platform.inspection.inspect;
    const customInspectSymbol = SymbolFor('nodejs.util.inspect.custom');
    const privateSymbols = platform.clone.privateSymbols;
    const perIsolateSymbols = platform.clone.symbols;
    const { codes, AbortError } = platform.values.errors;
    const validators = platform.values.validators;
    const modules = new SafeMap([
        ['events', platform.events],
        ['util', platform.inspection],
        ['internal/util/inspect', platform.inspection],
        ['internal/util/types', types],
        ['internal/util', {
            customInspectSymbol, kEmptyObject, kEnumerableProperty,
            setOwnProperty: (object, key, value) => ObjectDefineProperty(object, key, {
                __proto__: null, value, writable: true, enumerable: true, configurable: true,
            }),
        }],
        ['internal/errors', platform.values.errors],
        ['internal/validators', validators],
        ['internal/perf/utils', { now: platform.now }],
        ['internal/process/task_queues', { queueMicrotask: platform.queueMicrotask }],
        ['timers', platform.timers],
        ['internal/worker/js_transferable', platform.clone.protocol],
        ['internal/assert', value => { if (!value) throw new Error('Node event platform invariant failed'); }],
    ]);
    const SharedBuffer = globalThis.SharedArrayBuffer;
    const sharedLength = typeof SharedBuffer === 'function'
        ? ObjectGetOwnPropertyDescriptor(SharedBuffer.prototype, 'byteLength').get : null;
    const sharedGrowable = typeof SharedBuffer === 'function'
        ? ObjectGetOwnPropertyDescriptor(SharedBuffer.prototype, 'growable')?.get : null;
    function internalBinding(name) {
        if (name === 'messaging') return require('internal/per_context/domexception');
        if (name === 'util') return {
            setCloneMode: platform.clone.setMode,
            getSharedArrayBufferGrowable() {
                if (sharedGrowable) return ReflectApply(sharedGrowable, this, []);
                // An engine without a growable-SAB getter has fixed-length
                // shared buffers. Still perform the intrinsic receiver check.
                ReflectApply(sharedLength, this, []);
                return false;
            },
        };
        throw new Error('Unsupported Node event platform binding: ' + name);
    }
    const factories = {
        /* NODE_EVENT_MODULES */
    };
    const loading = new SafeMap();
    function require(name) {
        if (loading.has(name)) return loading.get(name).exports;
        if (modules.has(name)) return modules.get(name);
        if (!ObjectPrototypeHasOwnProperty(factories, name)) {
            throw new Error('Unsupported Node event platform dependency: ' + name);
        }
        const module = { exports: {} };
        loading.set(name, module);
        modules.set(name, module.exports);
        try {
            factories[name](module, module.exports, require, primordials, internalBinding,
                            platform.process, privateSymbols, perIsolateSymbols);
        } catch (error) {
            loading.delete(name);
            modules.delete(name);
            throw error;
        }
        modules.set(name, module.exports);
        loading.delete(name);
        return module.exports;
    }
    const eventTarget = require('internal/event_target');
    const abort = require('internal/abort_controller');
    const dom = require('internal/per_context/domexception');
    const { addAbortListener } = require('internal/events/abort_listener');
    const helpers = require('internal/events/public_helpers');
    ObjectAssign(platform.events, helpers, { addAbortListener });
    return { eventTarget, abort, dom, validators, addAbortListener, helpers, require };
}
