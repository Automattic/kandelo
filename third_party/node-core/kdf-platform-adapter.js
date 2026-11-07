// Pinned public password-KDF algorithms over native owned sync/queued work.
function _createNodeCryptoKdf(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { Error, RangeError, TypeError, ObjectDefineProperty, ReflectApply,
        SafeMap, ObjectPrototypeHasOwnProperty, ArrayBufferIsView, ArrayBufferPrototypeGetByteLength,
        ArrayBufferPrototypeGetDetached, DataViewPrototypeGetBuffer, DataViewPrototypeGetByteLength,
        TypedArrayPrototypeGetByteLength } = primordials;
    const { isAnyArrayBuffer, isArrayBufferView, isArrayBuffer, isDataView } = platform.types;
    const { Buffer } = platform;
    const { ERR_INVALID_ARG_TYPE } = platform.values.errors.codes;
    const { hideStackFrames } = platform.values.errors;
    /* NODE_KDF_BYTE_HELPERS */
    const kCryptoJobAsync = 0, kCryptoJobSync = 1, kCryptoJobWebCrypto = 2;
    function unwrap(packet) {
        if (ObjectPrototypeHasOwnProperty(packet, 'error')) throw packet.error;
        return packet.value;
    }
    function complete(status, syscall, packet) {
        const error = status < 0 ? platform.makeError(status, syscall) : packet[0];
        return ReflectApply(this.ondone, this, [error, status < 0 ? undefined : packet[1]]);
    }
    function PBKDF2Job(mode, password, salt, iterations, length, digest) {
        return unwrap(platform.native.createKdfJob(PBKDF2Job.prototype, complete,
            mode, 'pbkdf2', password, salt, [iterations, length, digest]));
    }
    function ScryptJob(mode, password, salt, N, r, p, maxmem, length) {
        return unwrap(platform.native.createKdfJob(ScryptJob.prototype, complete,
            mode, 'scrypt', password, salt, [N, r, p, maxmem, length]));
    }
    function Argon2Job(mode, message, nonce, parallelism, tagLength, memory, passes, secret, associatedData, type) {
        return unwrap(platform.native.createKdfJob(Argon2Job.prototype, complete,
            mode, 'argon2', message, nonce, [parallelism, tagLength, memory, passes, secret, associatedData, type]));
    }
    function HKDFJob(mode, digest, key, salt, info, length) {
        return unwrap(platform.native.createKdfJob(HKDFJob.prototype, complete,
            mode, 'hkdf', key, salt, [digest, info, length]));
    }
    for (const Job of [PBKDF2Job, ScryptJob, Argon2Job, HKDFJob]) {
        ObjectDefineProperty(Job.prototype, 'run', { configurable: true, writable: true,
            value: function run() {
                const result = unwrap(platform.native.runKdfJob(this));
                if (result === undefined) return;
                return [result[0], result[1]];
            } });
    }
    const binding = { PBKDF2Job, ScryptJob, HKDFJob,
        Argon2Job: platform.native.argon2Supported() ? Argon2Job : undefined,
        kTypeArgon2d: 0, kTypeArgon2i: 1, kTypeArgon2id: 2,
        kCryptoJobAsync, kCryptoJobSync, kCryptoJobWebCrypto };
    function missingWebCrypto() {
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('WebCrypto KDF key/job owner');
    }
    const modules = new SafeMap();
    const factories = {
        /* NODE_KDF_MODULES */
    };
    function require(name) {
        if (modules.has(name)) return modules.get(name).exports;
        if (name === 'buffer') return { Buffer, kMaxLength: platform.kMaxLength };
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/util') return platform.values.util;
        if (name === 'internal/crypto/util') return { ...platform.digestHelpers,
            toBuf, getBufferSourceByteLength, validateByteSource, validateAlgorithm: missingWebCrypto,
            normalizeHashName: missingWebCrypto, jobPromise: missingWebCrypto };
        if (name === 'internal/util/types') return platform.types;
        if (name === 'internal/crypto/keys') return platform.keys || { getCryptoKeyHandle: missingWebCrypto };
        if (!ObjectPrototypeHasOwnProperty(factories, name)) throw new Error('Unexpected KDF dependency: ' + name);
        const module = { exports: {} };
        modules.set(name, module);
        factories[name](module, module.exports, require, primordials, name => {
            if (name !== 'crypto') throw new Error('Unexpected KDF binding: ' + name);
            return binding;
        });
        return module.exports;
    }
    const { pbkdf2, pbkdf2Sync } = require('internal/crypto/pbkdf2');
    const { scrypt, scryptSync } = require('internal/crypto/scrypt');
    const { argon2, argon2Sync } = require('internal/crypto/argon2');
    const { hkdf, hkdfSync } = require('internal/crypto/hkdf');
    return { pbkdf2, pbkdf2Sync, scrypt, scryptSync, argon2, argon2Sync, hkdf, hkdfSync };
}
