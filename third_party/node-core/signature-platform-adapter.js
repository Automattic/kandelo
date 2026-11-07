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
    const binding = { Sign: SignHandle, Verify: VerifyHandle,
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
    const { Sign, Verify } = module.exports;
    /* NODE_SIGNATURE_CREATORS */
    // SignJob/one-shot and its native async ownership are separate consumers;
    // do not expose the unbound one-shot wrappers as working implementations.
    return { Sign, Verify, createSign, createVerify };
}
