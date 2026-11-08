// Complete pinned crypto WebIDL converters over the existing real generic
// WebIDL, native key brands and backing-source consumers. This is not Subtle.
function _createNodeCryptoWebIDL(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayBufferIsView, ArrayBufferPrototypeGetByteLength,
        DataViewPrototypeGetBuffer, DataViewPrototypeGetByteLength,
        TypedArrayPrototypeGetByteLength, TypedArrayPrototypeGetLength,
        Uint8Array } = primordials;
    const { isArrayBuffer, isDataView } = platform.types;
    const { lazyDOMException } = platform.values.util;
    const { ERR_METHOD_NOT_IMPLEMENTED } = platform.values.errors.codes;
    const ArrayBufferPrototypeGetDetached = primordials.ArrayBufferPrototypeGetDetached || (buffer => {
        try { new Uint8Array(buffer); return false; } catch { return true; }
    });
    const { getBufferSourceBytes, getHashes } = platform.digestHelpers;
    // Private engine delegates are captured at factory admission; this never
    // consults mutable public crypto.getFips or invents a provider capability.
    const { getFipsCrypto, getFipsCryptoGeneration } = platform.native;
    /* NODE_CRYPTO_WEBIDL_HELPERS */
    function require(name) {
        if (name === 'internal/webidl') return platform.webidl;
        if (name === 'internal/util') return platform.values.util;
        if (name === 'internal/crypto/keys') return platform.keys;
        if (name === 'internal/crypto/util') return {
            bigIntArrayToUnsignedInt, validateMaxBufferLength,
            getBufferSourceByteLength, getBufferSourceBytes,
            getHashes, isFips, kNamedCurveAliases, validateKmacKeyLength,
        };
        throw new ERR_METHOD_NOT_IMPLEMENTED('Crypto WebIDL dependency ' + name);
    }
    const module = { exports: {} };
    (function(module, exports, require, primordials) {
        /* NODE_CRYPTO_WEBIDL_MODULE */
    })(module, module.exports, require, primordials);
    return module.exports;
}
