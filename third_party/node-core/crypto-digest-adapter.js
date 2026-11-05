// Pinned public one-shot hashing over real uncached provider lookups. Existing
// incremental Hash/Hmac, key objects and async/WebCrypto jobs remain separate.
function _createNodeCryptoDigest(platform) {
    'use strict';
    const P = _createNodePrimordials();
    const { ArrayFrom, ArrayPrototypeSort, SafeMap, StringPrototypeToLowerCase,
        StringPrototypeReplace, TypedArrayPrototypeIncludes, ObjectCreate, Error, TypeError, RangeError,
        ArrayBufferIsView, ArrayBufferPrototypeGetByteLength,
        DataViewPrototypeGetBuffer, DataViewPrototypeGetByteLength, DataViewPrototypeGetByteOffset,
        TypedArrayPrototypeGetBuffer, TypedArrayPrototypeGetByteLength, TypedArrayPrototypeGetByteOffset,
        Uint8Array } = P;
    const { validateString, validateObject, validateUint32 } = platform.values.validators;
    const { codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE }, hideStackFrames } = platform.values.errors;
    const { normalizeEncoding, getDeprecationWarningEmitter } = platform.values.util;
    const { isArrayBufferView, isAnyArrayBuffer, isArrayBuffer, isDataView, isUint8Array } = platform.types;
    const Buffer = platform.Buffer;
    const BufferFrom = Buffer.from;
    const toString = P.uncurryThis(Buffer.prototype.toString);
    const ArrayBufferPrototypeGetDetached = P.ArrayBufferPrototypeGetDetached || (buffer => {
        try { new Uint8Array(buffer); return false; } catch { return true; }
    });
    /* NODE_DIGEST_BUFFER_BYTES */
    // No native algorithm-index cache has been populated in this embedding.
    // -1 is the pinned uncached path, never an invented provider handle.
    const cache = ObjectCreate(null);
    const getCachedHashId = () => -1;
    const getHashCache = () => cache;
    const encodingsMap = ObjectCreate(null); // Native bridge consumes the validated name, not Node enum IDs.
    /* NODE_DIGEST_BYTE_VALIDATION */
    /* NODE_DIGEST_NORMALIZATION */
    /* NODE_DIGEST_FILTER_NAMES */
    function oneShotDigest(algorithm, _id, _cache, input, encoding, _encodingId, outputLength, functionName, customization) {
        const result = platform.native.hashDigest(algorithm, input, outputLength,
            functionName !== undefined || customization !== undefined);
        if (!isUint8Array(result)) {
            const error = new Error(result.message);
            for (const key of ['library', 'reason', 'code', 'opensslErrorStack'])
                if (P.ObjectPrototypeHasOwnProperty(result, key)) error[key] = result[key];
            throw error;
        }
        const buffer = BufferFrom(result);
        return encoding === 'buffer' ? buffer : toString(buffer, encoding);
    }
    /* NODE_DIGEST_HASH */
    function getHashes() { return filterDuplicateStrings(platform.native.digestNames()); }
    function timingSafeEqual(a, b) {
        const result = platform.native.timingSafeEqual(a, b);
        if (typeof result === 'boolean') return result;
        if (result === 1 || result === 2) {
            const error = new TypeError(`The "buf${result}" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.`);
            error.code = 'ERR_INVALID_ARG_TYPE'; throw error;
        }
        if (result !== 3) throw new Error('Invalid native timing-safe comparison result');
        const error = new RangeError('Input buffers must have the same byte length');
        error.code = 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH'; throw error;
    }
    if (platform.captureHelpers !== undefined)
        platform.captureHelpers({ getArrayBufferOrView, getBufferSourceBytes });
    return { hash, getHashes, timingSafeEqual };
}
