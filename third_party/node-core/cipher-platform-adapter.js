// Pinned Cipheriv/Decipheriv classes over real private native EVP state.
function _createNodeCipherPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ObjectPrototypeHasOwnProperty, SafeMap, Error, TypeError, RangeError } = primordials;
    function call(operation, ...args) {
        const result = platform.native.cipherOperation(operation, ...args);
        if (result.error === undefined) return result.value;
        const record = result.error, code = record.code;
        const Ctor = code === 'ERR_CRYPTO_INVALID_KEYLEN' || code === 'ERR_CRYPTO_INVALID_MESSAGELEN' || code === 'ERR_OUT_OF_RANGE' ? RangeError :
            code === 'ERR_CRYPTO_INVALID_IV' || code === 'ERR_CRYPTO_INVALID_AUTH_TAG' || code === 'ERR_MISSING_ARGS' ? TypeError : Error;
        const error = new Ctor(record.message);
        for (const key of ['code', 'library', 'reason', 'opensslErrorStack'])
            if (ObjectPrototypeHasOwnProperty(record, key)) error[key] = record[key];
        throw error;
    }
    class CipherBase {
        constructor(encrypt, name, key, iv, tag, cts, xts) {
            return call('new', new.target.prototype, encrypt, name, key, iv, tag, cts, xts);
        }
        update(data, encoding) {
            if (typeof data === 'string') {
                const mode = call('encoding', encoding, false);
                data = platform.codecs.fromString(data, mode === 'buffer' ? 'utf8' : mode);
            }
            return platform.codecs.copyBytes(call('update', this, data));
        }
        final() { return platform.codecs.copyBytes(call('final', this)); }
        getAuthTag() {
            const value = call('getTag', this);
            return value === undefined ? undefined : platform.codecs.copyBytes(value);
        }
        setAuthTag(value) { return call('setTag', this, value); }
        setAAD(value, length) { return call('aad', this, value, length); }
        setAutoPadding(value) { return call('padding', this, value); }
    }
    const unavailable = () => { throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('RSA cipher native owner'); };
    const binding = { CipherBase, getCipherInfo: (...args) => call('info', ...args),
        privateDecrypt: unavailable, privateEncrypt: unavailable, publicDecrypt: unavailable, publicEncrypt: unavailable };
    const { validateString } = platform.values.validators;
    /* NODE_CIPHER_HELPERS */
    const dependencies = new SafeMap([
        ['internal/errors', platform.values.errors], ['internal/validators', platform.values.validators],
        ['internal/crypto/keys', platform.keys], ['internal/crypto/util', {
            ...platform.digestHelpers, getStringOption, kHandle: platform.kHandle,
        }],
        ['internal/util/types', platform.types], ['internal/util', platform.values.util],
        ['internal/streams/lazy_transform', platform.streams.require('internal/streams/lazy_transform')],
        ['string_decoder', platform.stringDecoder],
    ]);
    const module = { exports: {} };
    (function(module, exports, require, primordials, internalBinding) {
        /* NODE_CIPHER_PUBLIC */
    })(module, module.exports, name => {
        if (dependencies.has(name)) return dependencies.get(name);
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Cipher dependency ' + name);
    }, primordials, name => name === 'crypto' ? binding :
        name === 'constants' ? { crypto: call('constants') } : undefined);
    const { Cipheriv, Decipheriv, getCipherInfo } = module.exports;
    /* NODE_CIPHER_CREATORS */
    // Fetch a fresh provider list and apply the unchanged target duplicate/
    // case policy. No fabricated FIPS generation or cached capability exists.
    function providerArray(fn) { return () => fn(); }
    const getCiphers = providerArray(() => platform.digestHelpers.filterDuplicateStrings(call('list')));
    return { Cipheriv, Decipheriv, createCipheriv, createDecipheriv, getCipherInfo, getCiphers };
}
