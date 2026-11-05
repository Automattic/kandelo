// Pinned public digest classes over real native contexts and private bytes.
function _createNodeIncrementalCrypto(platform) {
    'use strict';
    const P = _createNodePrimordials();
    const { FunctionPrototypeCall, ObjectSetPrototypeOf, StringPrototypeReplace,
        StringPrototypeToLowerCase, Symbol, TypedArrayPrototypeIncludes,
        StringPrototypeIndexOf, StringPrototypeSlice, ObjectCreate, Error, TypeError, RangeError } = P;
    const { codes: { ERR_CRYPTO_HASH_FINALIZED, ERR_CRYPTO_HASH_UPDATE_FAILED,
        ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE,
        ERR_METHOD_NOT_IMPLEMENTED } } = platform.values.errors;
    const { validateEncoding, validateString, validateObject, validateUint32 } = platform.values.validators;
    const { normalizeEncoding, getDeprecationWarningEmitter, deprecate } = platform.values.util;
    const { isArrayBufferView, isAnyArrayBuffer } = platform.types;
    const { Buffer } = platform;
    const kHandle = Symbol('kHandle');
    const LazyTransform = platform.streams.require('internal/streams/lazy_transform');
    const { getArrayBufferOrView, getBufferSourceBytes } = platform.digestHelpers;
    const cache = ObjectCreate(null), getCachedHashId = () => -1, getHashCache = () => cache;

    // Only actual private key owners supply these brands and handles;
    // property-shaped objects and outer-host keys cannot supply guest material.
    const isKeyObject = key => platform.keys !== undefined && platform.keys.isKeyObject(key);
    const isCryptoKey = key => platform.keys !== undefined && platform.keys.isCryptoKey(key);
    const getKeyObjectType = key => platform.keys.getKeyObjectType(key);
    const getKeyObjectHandle = key => platform.keys.getKeyObjectHandle(key);
    const getCryptoKeyType = key => platform.keys.getCryptoKeyType(key);
    const getCryptoKeyHandle = key => platform.keys.getCryptoKeyHandle(key);
    const emitDEP0203 = getDeprecationWarningEmitter('DEP0203',
        'Passing a CryptoKey to node:crypto functions is deprecated.');
    /* NODE_INCREMENTAL_KEY_TYPES */
    /* NODE_INCREMENTAL_PREPARE_KEY */
    /* NODE_INCREMENTAL_STRING_OPTION */

    function call(operation, ...args) {
        const result = platform.native.incrementalHash(operation, ...args);
        if (result.error === undefined) return result.value;
        const record = result.error;
        const code = P.ObjectPrototypeHasOwnProperty(record, 'code') ? record.code : undefined;
        const Ctor = code === 'ERR_CRYPTO_INVALID_DIGEST' ? TypeError :
            code === 'ERR_OUT_OF_RANGE' ? RangeError : Error;
        const error = new Ctor(record.message);
        const fields = ['code', 'library', 'reason', 'opensslErrorStack'];
        for (let i = 0; i < fields.length; i++) {
            const key = fields[i];
            if (P.ObjectPrototypeHasOwnProperty(record, key)) error[key] = record[key];
        }
        throw error;
    }
    function input(data, encoding) {
        if (typeof data !== 'string') return data;
        const mode = call('encoding', encoding, false);
        return platform.codecs.fromString(data, mode === 'buffer' ? 'utf8' : mode);
    }
    function output(handle, encoding) {
        const mode = call('encoding', encoding, true);
        const bytes = call('digest', handle);
        return mode === 'buffer' ? platform.codecs.copyBytes(bytes) : platform.codecs.decodeBytes(bytes, mode);
    }
    const _Hash = class Hash {
        #owner;
        constructor(algorithm, length, _id, _cache, functionName, customization) {
            this.#owner = algorithm instanceof _Hash ? call('copy', algorithm.#owner, length) :
                call('create', algorithm, length, functionName !== undefined || customization !== undefined);
        }
        update(data, encoding) { return call('update', this.#owner, input(data, encoding)); }
        digest(encoding) { return output(this.#owner, encoding); }
    };
    const _Hmac = class Hmac {
        #owner;
        init(algorithm, key) { this.#owner = call('hmac', algorithm, key); }
        update(data, encoding) { return call('update', this.#owner, input(data, encoding)); }
        digest(encoding) { return output(this.#owner, encoding); }
    };
    /* NODE_INCREMENTAL_CLASSES */
    /* NODE_INCREMENTAL_CREATORS */
    return { api: {
        /* NODE_INCREMENTAL_PUBLIC_CONSTRUCTORS */
        createHash, createHmac,
    }, symbols: { kHandle } };
}
