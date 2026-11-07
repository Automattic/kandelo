// Portable public util algorithms share real validators, timers and promises.
function _installNodeUtilAlgorithms(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { Error, ObjectPrototypeHasOwnProperty, ReflectApply, SafeMap } = primordials;
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
    // Real native DATA cells own lazy initialization, holder/realm identity,
    // descriptor materialization and inherited/integrity transitions. The
    // callback is retained by the existing traced native capability owner.
    const defineNativeLazy = platform.defineNativeLazyDataProperty;
    function loadLazyExport(id, key) { return require(id)[key]; }
    function lazyData(key, id) {
        ReflectApply(defineNativeLazy, undefined,
            [platform.util, key, loadLazyExport, id, 7]);
    }
    lazyData('parseArgs', 'internal/util/parse_args/parse_args');
    lazyData('diff', 'internal/util/diff');
    const module = { exports: platform.util };
    const { ObjectDefineProperties } = primordials;
    /* NODE_UTIL_ALGORITHM_PROPERTIES */
    return { require };
}
