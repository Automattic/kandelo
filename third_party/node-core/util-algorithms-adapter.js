// Portable public util algorithms share real validators, timers and promises.
function _installNodeUtilAlgorithms(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { Error, ObjectDefineProperty, ObjectGetOwnPropertyDescriptor, ObjectIsExtensible, ObjectPrototypeHasOwnProperty, SafeMap } = primordials;
    const process = platform.process;
    const modules = new SafeMap();
    const factories = {
        /* NODE_UTIL_ALGORITHM_MODULES */
    };
    const dependencies = new SafeMap([
        ['internal/errors', platform.values.errors],
        ['internal/validators', platform.values.validators],
        ['internal/util', platform.values.util],
        ['internal/events/abort_listener', { addAbortListener: platform.addAbortListener }],
        ['internal/options', { getOptionValue: platform.getOptionValue }],
        ['internal/timers', { TIMEOUT_MAX: /* NODE_UTIL_TIMEOUT_MAX */ }],
        ['timers', platform.timers],
    ]);
    function require(name) {
        if (dependencies.has(name)) return dependencies.get(name);
        if (modules.has(name)) return modules.get(name).exports;
        if (!ObjectPrototypeHasOwnProperty(factories, name)) {
            throw new Error('Unknown util algorithm dependency: ' + name);
        }
        const module = { exports: {} };
        modules.set(name, module);
        try { factories[name](module, module.exports, require, primordials, internalBinding, process); }
        catch (error) { modules.delete(name); throw error; }
        return module.exports;
    }
    function internalBinding(name) {
        if (name === 'util') return { markPromiseAsHandled: platform.markPromiseAsHandled };
        if (name === 'timers') return { getLibuvNow: platform.getLibuvNow };
        throw new Error('Unknown util algorithm binding: ' + name);
    }
    // These functions execute actual algorithms. V8's invisible lazy data
    // property hook is still missing in this engine embedding: this JS lazy
    // accessor is observably different before first read/descriptor lookup.
    // Keep that as an implementation gap, not an accepted engine exclusion.
    function lazyData(key, id) {
        ObjectDefineProperty(platform.util, key, {
            __proto__: null, configurable: true, enumerable: true,
            get() {
                const value = require(id)[key];
                const descriptor = ObjectGetOwnPropertyDescriptor(this, key);
                if (descriptor?.configurable || (descriptor === undefined && ObjectIsExtensible(this))) {
                    ObjectDefineProperty(this, key, { __proto__: null, value,
                        configurable: true, enumerable: true, writable: true });
                }
                return value;
            },
            set(value) { ObjectDefineProperty(this, key, { __proto__: null, value,
                configurable: true, enumerable: true, writable: true }); },
        });
    }
    lazyData('parseArgs', 'internal/util/parse_args/parse_args');
    lazyData('diff', 'internal/util/diff');
    const module = { exports: platform.util };
    const { ObjectDefineProperties } = primordials;
    /* NODE_UTIL_ALGORITHM_PROPERTIES */
    return { require };
}
