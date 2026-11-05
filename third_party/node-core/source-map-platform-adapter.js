// The full pinned SourceMap class owns decoding and queries. Loader capture,
// cached source/URL lifetime and stack remapping require separate real owners.
function _createNodeSourceMapPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const module = { exports: {} };
    const require = name => {
        if (name === 'internal/validators') return platform.values.validators;
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('SourceMap dependency ' + name);
    };
    (function(module, exports, require, primordials) {
        /* NODE_PUBLIC_SOURCE_MAP */
    })(module, module.exports, require, primordials);
    return { SourceMap: module.exports.SourceMap };
}
