// Complete pinned symmetric public algorithms over the real native key job.
function _createNodeSymmetricKeygen(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { FunctionPrototypeCall } = primordials;
    const { validateString, validateObject, validateInteger, validateOneOf,
        validateFunction } = platform.values.validators;
    const { codes: { ERR_INVALID_ARG_VALUE } } = platform.values.errors;
    const { isArrayBufferView } = platform.types;
    const { SecretKeyObject } = platform.keys;
    const kCryptoJobAsync = 0, kCryptoJobSync = 1;
    function complete(status, syscall, packet) {
        const error = status < 0 ? platform.makeError(status, syscall) : packet[0];
        return primordials.ReflectApply(this.ondone, this,
            [error, status < 0 ? undefined : packet[1]]);
    }
    function SecretKeyGenJob(mode, length) {
        return platform.keys.keyOperation('createSecretGen', SecretKeyGenJob.prototype,
            complete, mode, length, platform.keys.nativeHandlePrototype);
    }
    primordials.ObjectDefineProperty(SecretKeyGenJob.prototype, 'run', {
        configurable: true, writable: true,
        value: function run() { return platform.keys.keyOperation('runSecretGen', this); },
    });
    /* NODE_SECRET_KEY_WRAP */
    /* NODE_SECRET_KEY_GENERATION */
    return { generateKey, generateKeySync };
}
