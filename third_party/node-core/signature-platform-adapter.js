// Complete pinned Sign/Verify wrappers over actual private native digest/key owners.
function _createNodeSignaturePlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    function call(operation, ...args) {
        const packet = platform.native.signatureOperation(operation, ...args);
        if (packet.error !== undefined) throw packet.error;
        return packet.value;
    }
    class SignHandle {
        constructor() { return call('new', new.target.prototype, false); }
        init(algorithm) { return call('init', this, algorithm); }
        update(data, encoding) { return call('update', this, data, encoding); }
        sign(...args) { return platform.codecs.copyBytes(call('sign', this, ...args)); }
    }
    class VerifyHandle {
        constructor() { return call('new', new.target.prototype, true); }
        init(algorithm) { return call('init', this, algorithm); }
        update(data, encoding) { return call('update', this, data, encoding); }
        verify(...args) { return call('verify', this, ...args); }
    }
    function complete(status, syscall, packet) {
        const error = status < 0 ? platform.makeError(status, syscall) : packet[0];
        return primordials.ReflectApply(this.ondone, this, [error, status < 0 ? undefined : packet[1]]);
    }
    function SignJob(mode, operation, ...args) {
        return call('createJob', SignJob.prototype, complete, mode, operation, ...args);
    }
    primordials.ObjectDefineProperty(SignJob.prototype, 'run', { configurable: true, writable: true,
        value: function run() { return call('runJob', this); } });
    const binding = { Sign: SignHandle, Verify: VerifyHandle, SignJob,
        kCryptoJobAsync: 0, kCryptoJobSync: 1, kSignJobModeSign: 0, kSignJobModeVerify: 1,
        kSigEncDER: 0, kSigEncP1363: 1 };
    const module = { exports: {} };
    const dependencies = new primordials.SafeMap([
        ['internal/errors', platform.values.errors], ['internal/validators', platform.values.validators],
        ['internal/crypto/util', { ...platform.digestHelpers, kHandle: platform.kHandle }],
        ['internal/crypto/keys', platform.keys], ['stream', platform.streams],
        ['buffer', { Buffer: platform.Buffer }], ['internal/util/types', platform.types],
    ]);
    (function(module, exports, require, primordials, internalBinding) {
        /* NODE_SIGNATURE_PUBLIC */
    })(module, module.exports, name => {
        if (dependencies.has(name)) return dependencies.get(name);
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Signature dependency ' + name);
    }, primordials, name => name === 'crypto' ? binding :
        name === 'constants' ? platform.constants : undefined);
    const { Sign, Verify, signOneShot, verifyOneShot } = module.exports;
    /* NODE_SIGNATURE_CREATORS */
    return { Sign, Verify, createSign, createVerify, sign: signOneShot, verify: verifyOneShot };
}
