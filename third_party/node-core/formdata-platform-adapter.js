// Pinned Undici owns FormData/Headers state, Web IDL and live iterators. Fetch
// Body extraction/parsing consumes these same owners; transport is separate.
function _createNodeFormDataPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { Error, ObjectPrototypeHasOwnProperty, SafeMap } = primordials;
    const { Blob, File, ReadableStream, URL, URLSearchParams, AbortSignal, MessagePort, Event } = platform;
    const factories = {
        __proto__: null,
        /* NODE_FORMDATA_MODULES */
    };
    const modules = new SafeMap();
    function require(name) {
        if (name === 'node:assert') return platform.assert;
        if (name === 'node:util') return platform.util;
        if (name === 'node:crypto') return platform.crypto;
        if (name === '../../core/util') return { kEnumerableProperty: platform.values.util.kEnumerableProperty,
            setHeader: require('iterator').setHeader };
        if (name === 'node:worker_threads') return {
            // Every caller here is a newly created, nontransferable FormData or Headers.
            // Register actual mode zero with the guest serializer, rather than
            // a no-op worker facade. Public worker marking policy remains open.
            markAsUncloneable: object => platform.clone.protocol.markTransferMode(object, false, false),
        };
        if (name === '../../core/symbols') return require('coreSymbols');
        const id = name === './util' ? 'iterator' : name === '../webidl' ? 'webidl' :
            name === '../../util/runtime-features.js' ? 'runtimeFeatures' : name;
        if (modules.has(id)) return modules.get(id).exports;
        if (!ObjectPrototypeHasOwnProperty(factories, id)) {
            const error = new Error('Unsupported FormData dependency: ' + name);
            error.code = 'ERR_NOT_IMPLEMENTED'; throw error;
        }
        const module = { exports: {} };
        modules.set(id, module);
        try { factories[id](module, module.exports, require); }
        catch (error) { modules.delete(id); throw error; }
        return module.exports;
    }
    return { ...require('formdata'), headers: require('headers'), coreSymbols: require('coreSymbols'), webidl: require('webidl').webidl, get messageEvents() { return require('websocketEvents'); } };
}
