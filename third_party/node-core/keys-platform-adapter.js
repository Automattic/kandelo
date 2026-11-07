// Pinned KeyObject/CryptoKey wrappers over actual private engine key owners.
function _createNodeCryptoKeys(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ObjectDefineProperty, ObjectPrototypeHasOwnProperty, SafeMap, Error, RangeError,
        TypeError, BigInt, TypedArrayPrototypeGetLength, ReflectApply } = primordials;
    const { ERR_INVALID_THIS, ERR_METHOD_NOT_IMPLEMENTED } = platform.values.errors.codes;
    function call(operation, ...args) {
        const packet = platform.native.keyOperation(operation, ...args);
        if (ObjectPrototypeHasOwnProperty(packet, 'error') && packet.error !== undefined) {
            throw packet.error;
        }
        return packet.value;
    }
    class KeyObjectHandle {
        constructor() { return call('newHandle', new.target.prototype); }
        init(...args) {
            if (args[2] === binding.kKeyFormatJWK)
                return call('initJwk', this, args[0], args[1]);
            return call('init', this, ...args);
        }
        getKeyType() { return call('type', this); }
        getSymmetricKeySize() { return call('size', this); }
        getAsymmetricKeyType() { return call('asymmetricType', this); }
        keyDetail(target) { return call('detail', this, target); }
        equals(other) { return call('equals', this, other); }
        export(...args) {
            const value = call('export', this, ...args);
            return typeof value === 'string' ? value : platform.codecs.copyBytes(value);
        }
        exportJwk(target, handleRsaPss) {
            return call('exportJwk', this, target, handleRsaPss);
        }
        rawPublicKey() { return platform.codecs.copyBytes(call('rawPublic', this)); }
        rawPrivateKey() { return platform.codecs.copyBytes(call('rawPrivate', this)); }
        rawSeed() { return platform.codecs.copyBytes(call('rawSeed', this)); }
        exportECPublicRaw(form) { return platform.codecs.copyBytes(call('ecPublic', this, form)); }
        exportECPrivateRaw() { return platform.codecs.copyBytes(call('ecPrivate', this)); }
        exportECPrivatePkcs8() { return platform.codecs.copyBytes(call('ecPkcs8', this)); }
        checkEcKeyData() { return call('checkEc', this); }
    }
    class NativeKeyObject {
        constructor(handle) { return call('newObject', new.target.prototype, handle); }
    }
    class NativeCryptoKey {
        constructor(handle, algorithm, mask, extractable, secondary, seed) {
            return call('newCryptoKey', new.target.prototype, handle, algorithm, mask, extractable, secondary, seed);
        }
    }
    const binding = {
        ...call('constants'), KeyObjectHandle,
        createNativeKeyObjectClass: callback => callback(NativeKeyObject),
        createCryptoKeyClass: callback => callback(NativeCryptoKey),
        isKeyObject: key => call('isKeyObject', key),
        isCryptoKey: key => call('isCryptoKey', key),
        getKeyObjectSlots(key) {
            const slots = call('slots', key);
            if (slots === undefined) throw new ERR_INVALID_THIS('KeyObject');
            return slots;
        },
        getCryptoKeySlots(key) {
            const slots = call('cryptoSlots', key);
            if (slots === undefined) throw new ERR_INVALID_THIS('CryptoKey');
            return slots;
        },
        parsePKCS12(bundle, passphrase) {
            return call('parsePKCS12', KeyObjectHandle.prototype,
                platform.getX509().nativeHandlePrototype, bundle, passphrase);
        },
    };
    function missingWebCrypto() { throw new ERR_METHOD_NOT_IMPLEMENTED('WebCrypto algorithm/import owner'); }
    /* NODE_KEY_BIGINT */
    const modules = new SafeMap();
    const factories = {
        /* NODE_KEY_MODULES */
    };
    function require(name) {
        if (modules.has(name)) return modules.get(name).exports;
        if (name === 'internal/crypto/x509') return platform.getX509();
        if (name === 'buffer') return { Buffer: platform.Buffer };
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/util/types') return platform.types;
        if (name === 'internal/util') return platform.values.util;
        if (name === 'internal/util/inspect') return platform.inspection;
        if (name === 'internal/url') return platform.url;
        if (name === 'internal/crypto/util') return { ...platform.digestHelpers,
            bigIntArrayToUnsignedBigInt, normalizeAlgorithm: missingWebCrypto,
            hasAnyNotIn: missingWebCrypto, getUsagesMask: missingWebCrypto,
            getUsagesFromMask: missingWebCrypto, hasUsage: missingWebCrypto,
            toUsagesSet: missingWebCrypto };
        if (!ObjectPrototypeHasOwnProperty(factories, name))
            throw new ERR_METHOD_NOT_IMPLEMENTED('Key dependency ' + name);
        const module = { exports: {} };
        modules.set(name, module);
        factories[name](module, module.exports, require, primordials, name => {
            if (name === 'crypto') return binding;
            if (name === 'constants') return platform.constants;
            throw new ERR_METHOD_NOT_IMPLEMENTED('Key binding ' + name);
        });
        return module.exports;
    }
    const keys = require('internal/crypto/keys');
    return { ...keys, api: { KeyObject: keys.KeyObject, createSecretKey: keys.createSecretKey,
        createPublicKey: keys.createPublicKey, createPrivateKey: keys.createPrivateKey,
        parsePKCS12: keys.parsePKCS12 },
        keyOperation: call, nativeHandlePrototype: KeyObjectHandle.prototype };
}
