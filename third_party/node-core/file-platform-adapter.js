// The pinned File class owns metadata and clone hooks. Blob byte ownership
// remains in the shared body owner; copying File does not complete that owner.
function _createNodeFilePlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    function require(name) {
        if (name === 'internal/blob') return platform.blob;
        if (name === 'internal/util') return platform.values.util;
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/util/inspect') return platform.inspection;
        if (name === 'internal/worker/js_transferable') return platform.clone.protocol;
        throw new primordials.Error('Unsupported File dependency: ' + name);
    }
    const module = { exports: {} };
    (function(module, exports, require, primordials) {
        /* NODE_FILE_MODULE */
    })(module, module.exports, require, primordials);
    return module.exports;
}
