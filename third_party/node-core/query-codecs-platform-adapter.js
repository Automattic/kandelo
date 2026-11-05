// Shared public/private query-string and Unicode algorithms. Punycode is
// evaluated on first actual load, including its real origin/warning call.
function _createNodeQueryCodecsPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { Error, SafeMap } = primordials;
    const process = platform.process;
    const factories = {
        __proto__: null,
        /* NODE_QUERY_CODECS_MODULES */
    };
    const modules = new SafeMap();
    function internalBinding(name) {
        if (name === 'util') return { isInsideNodeModules: platform.isInsideNodeModules };
        throw new Error('Unsupported query/Unicode codec binding: ' + name);
    }
    function require(name) {
        if (name === 'buffer') return { Buffer: platform.Buffer };
        if (name === 'internal/errors') return platform.values.errors;
        if (modules.has(name)) return modules.get(name).exports;
        if (!factories[name]) throw new Error('Unsupported query/Unicode codec dependency: ' + name);
        const module = { exports: {} };
        modules.set(name, module);
        try { factories[name](module, module.exports, require, primordials, internalBinding, process); }
        catch (error) { modules.delete(name); throw error; }
        return module.exports;
    }
    return { require };
}
