// Pinned Cipheriv/Decipheriv classes over real private native EVP state.
function _createNodeCipherPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ObjectPrototypeHasOwnProperty, SafeMap, Error, TypeError, RangeError } = primordials;
    function call(operation, ...args) {
        const result = platform.native.cipherOperation(operation, ...args);
        if (result.error === undefined) return result.value;
        throw result.error;
    }
    class CipherBase {
        constructor(encrypt, name, key, iv, tag, cts, xts) {
            return call('new', new.target.prototype, encrypt, name, key, iv, tag, cts, xts);
        }
        update(data, encoding) {
            return platform.codecs.copyBytes(call('update', this, data, encoding));
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
    const rsa = operation => (...args) => platform.codecs.copyBytes(call('rsa', operation, ...args));
    const binding = { CipherBase, getCipherInfo: (...args) => call('info', ...args),
        publicEncrypt: rsa(0), privateDecrypt: rsa(1), privateEncrypt: rsa(2), publicDecrypt: rsa(3) };
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
        name === 'constants' ? platform.constants : undefined);
    const { Cipheriv, Decipheriv, getCipherInfo, publicEncrypt, privateDecrypt, privateEncrypt, publicDecrypt } = module.exports;
    /* NODE_CIPHER_CREATORS */
    // Fetch a fresh provider list and apply the unchanged target duplicate/
    // case policy. No fabricated FIPS generation or cached capability exists.
    function providerArray(fn) { return () => fn(); }
    const getCiphers = providerArray(() => platform.digestHelpers.filterDuplicateStrings(call('list')));
    return { Cipheriv, Decipheriv, createCipheriv, createDecipheriv, getCipherInfo, getCiphers,
        publicEncrypt, privateDecrypt, privateEncrypt, publicDecrypt };
}
