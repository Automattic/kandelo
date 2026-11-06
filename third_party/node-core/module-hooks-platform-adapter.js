// Unmodified synchronous customization-hook policy over actual loader owners.
function _createNodeModuleHooks(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const module = { exports: {} };
    function require(name) {
        if (name === 'internal/bootstrap/realm') return { BuiltinModule: {
            normalizeRequirableId: platform.normalizeBuiltin,
            canBeRequiredByUsers: platform.canBeRequiredByUsers,
        } };
        if (name === 'path') return platform.path;
        if (name === 'internal/url') return platform.url;
        if (name === 'internal/encoding') return { TextDecoder: platform.TextDecoder };
        return platform.values.require(name);
    }
    (function(module, exports, require, primordials) {
        /* NODE_MODULE_CUSTOMIZATION_HOOKS */
    })(module, module.exports, require, primordials);
    return module.exports;
}
