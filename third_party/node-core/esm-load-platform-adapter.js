// Unchanged default source/format/import-attribute loading over actual fs,
// URL, MIME, encoding and shared synchronous hook owners. No worker is emulated.
function _createNodeESMLoadPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { SafeMap, ObjectPrototypeHasOwnProperty } = primordials;
    const factories = { /* NODE_ESM_SOURCE_MODULES */ };
    const modules = new SafeMap();
    function require(name) {
        if (modules.has(name)) return modules.get(name).exports;
        if (name === 'internal/modules/esm/get_format') return platform.policy.format;
        if (name === 'internal/modules/helpers') return { loaderMethods: { readFileSync: platform.readBuffer } };
        if (name === 'internal/url') return platform.url;
        if (name === 'internal/options') return { getOptionValue: platform.getOptionValue };
        if (name === 'internal/mime') return platform.getMIME();
        if (name === 'internal/encoding') return { TextEncoder: platform.TextEncoder };
        if (name === 'buffer') return { Buffer: platform.Buffer };
        if (ObjectPrototypeHasOwnProperty(factories, name)) {
            const module = { exports: {} }; modules.set(name, module);
            try { factories[name](module, module.exports, require, primordials); }
            catch (error) { modules.delete(name); throw error; }
            return module.exports;
        }
        return platform.values.require(name);
    }
    return require('internal/modules/esm/load');
}
