// The pinned synchronous random algorithms own brands, units and errors.
// Entropy comes from the actual guest /dev/urandom owner, not a JS PRNG or
// the embedding host's crypto module. Async crypto work remains separate.
function _createNodeCryptoRandomSync(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const {
        ArrayBufferPrototypeGetByteLength, DataViewPrototypeGetBuffer,
        DataViewPrototypeGetByteLength, DataViewPrototypeGetByteOffset,
        MathMin, NumberIsNaN, TypedArrayPrototypeGetBuffer,
        TypedArrayPrototypeGetByteLength, TypedArrayPrototypeGetByteOffset,
        TypedArrayPrototypeGetSymbolToStringTag, Uint8Array,
    } = primordials;
    const { isArrayBufferView, isAnyArrayBuffer, isDataView, isSharedArrayBuffer,
        isTypedArray, isFloat16Array, isFloat32Array, isFloat64Array } = platform.types;
    const { validateNumber } = platform.values.validators;
    const { ERR_INVALID_ARG_TYPE, ERR_OUT_OF_RANGE } = platform.values.errors.codes;
    const { lazyDOMException } = platform.values.util;
    const kMaxLength = platform.kMaxLength;
    function internalBinding(name) {
        if (name === 'messaging') return platform.dom;
        throw new primordials.Error('Unsupported random binding: ' + name);
    }
    function randomFillSyncImpl(value, offset, size) {
        const view = isArrayBufferView(value);
        const dataView = view && isDataView(value);
        const buffer = !view ? value : dataView ? DataViewPrototypeGetBuffer(value) : TypedArrayPrototypeGetBuffer(value);
        const base = !view ? 0 : dataView ? DataViewPrototypeGetByteOffset(value) : TypedArrayPrototypeGetByteOffset(value);
        platform.fillBytes(new Uint8Array(buffer, base + offset, size));
    }
    const operations = (function() {
        /* NODE_CRYPTO_RANDOM_SYNC */
        return { randomFillSync, getRandomValues };
    })();
    // node:crypto forwards through Web Crypto's argument conversion before
    // reaching the integer-array algorithm. This private receiver is not an
    // exported Crypto/SubtleCrypto implementation or fabricated key support.
    const web = (function() {
        const _getRandomValues = operations.getRandomValues;
        const { ERR_INVALID_THIS } = platform.values.errors.codes;
        const webidl = platform.webidl;
        const crypto = {};
        /* NODE_CRYPTO_RANDOM_WEB_WRAPPER */
        crypto.getRandomValues = getRandomValues;
        return { crypto };
    })();
    function lazyWebCrypto() { return web; }
    /* NODE_CRYPTO_RANDOM_PUBLIC_WRAPPER */
    return { randomFillSync: operations.randomFillSync, getRandomValues };
}
