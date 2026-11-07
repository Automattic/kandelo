// The public lifecycle/validation is unchanged Node source. The binding owns
// real guest descriptors and current nested Wasm memory; host node:wasi is
// never a production dependency. Missing import operations stay absent.
function _createNodeWasiPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const module = { exports: {} };
    const require = name => {
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/util') return platform.values.util;
        throw new primordials.Error('Unresolved WASI dependency: ' + name);
    };
    let constructor;
    const internalBinding = name => {
        if (name !== 'wasi') throw new primordials.Error('Unresolved WASI binding: ' + name);
        constructor ??= platform.native.wasiConstructor();
        return { WASI: constructor };
    };
    (function(module, exports, require, internalBinding, primordials) {
        /* NODE_WASI_MODULE */
    })(module, module.exports, require, internalBinding, primordials);
    return module.exports;
}
