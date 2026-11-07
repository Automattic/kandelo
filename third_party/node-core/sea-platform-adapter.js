// Ordinary-image public SEA behavior, gated by actual compiled image bytes.
// No JS/argv flag, asset table or native-format resource lookup is fabricated.
function _createNodeSeaPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const binding = platform.native.seaBinding();
    // A marked image needs real resource/startup ownership before this module
    // can serve it. Never turn unsupported format lookup into missing assets.
    if (binding.isSea())
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('SEA resource and startup profile');
    const module = { exports: {} };
    function internalBinding(name) {
        if (name === 'sea') return binding;
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('SEA binding ' + name);
    }
    function require(name) {
        if (name === 'internal/encoding') return { TextDecoder: platform.TextDecoder };
        if (name === 'internal/blob') return { Blob: platform.Blob };
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/errors') return platform.values.errors;
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('SEA dependency ' + name);
    }
    (function(module, exports, require, primordials, internalBinding) {
        /* NODE_SEA_PUBLIC */
    })(module, module.exports, require, primordials, internalBinding);
    return module.exports;
}
