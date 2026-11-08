// Complete unchanged public asymmetric keygen algorithms over actual native jobs.
function _createNodeAsymmetricKeygen(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { FunctionPrototypeCall, ObjectDefineProperty, ObjectGetPrototypeOf,
        SafeArrayIterator } = primordials;
    const { PublicKeyObject, PrivateKeyObject, parsePublicKeyEncoding,
        parsePrivateKeyEncoding } = platform.keys;
    const { customPromisifyArgs, kEmptyObject } = platform.values.util;
    const { validateFunction, validateBuffer, validateString, validateInteger,
        validateObject, validateOneOf, validateInt32, validateUint32 } = platform.values.validators;
    const { codes: { ERR_INCOMPATIBLE_OPTION_PAIR, ERR_INVALID_ARG_VALUE,
        ERR_MISSING_OPTION } } = platform.values.errors;
    const { isArrayBufferView } = platform.types;
    const { kCryptoJobAsync, kCryptoJobSync, kKeyVariantRSA_PSS,
        kKeyVariantRSA_SSA_PKCS1_v1_5, OPENSSL_EC_NAMED_CURVE,
        OPENSSL_EC_EXPLICIT_CURVE, pairRsa, pairDsa, pairEc, pairDh,
        pairNamed } = platform.keys.keyOperation('pairConstants');
    function create(receiver, kind, args) {
        // Construction already performed its genuine newTarget prototype Get.
        // Read this real fresh receiver's intrinsic prototype, not the public
        // constructor.prototype property a second time.
        return platform.keys.keyOperation('createPairGen', ObjectGetPrototypeOf(receiver),
            platform.keys.nativeHandlePrototype, platform.codecs.copyBytes, kind, ...args);
    }
    function RsaKeyPairGenJob(...args) { return create(this, pairRsa, args); }
    function DsaKeyPairGenJob(...args) { return create(this, pairDsa, args); }
    function EcKeyPairGenJob(...args) { return create(this, pairEc, args); }
    function DhKeyPairGenJob(...args) { return create(this, pairDh, args); }
    function NamedKeyPairGenJob(...args) { return create(this, pairNamed, args); }
    for (const constructor of [RsaKeyPairGenJob, DsaKeyPairGenJob, EcKeyPairGenJob,
        DhKeyPairGenJob, NamedKeyPairGenJob]) {
        ObjectDefineProperty(constructor.prototype, 'run', {
            configurable: true, writable: true,
            value: function run() { return platform.keys.keyOperation('runPairGen', this); },
        });
    }
    /* NODE_ASYMMETRIC_KEY_GENERATION */
    return { generateKeyPair, generateKeyPairSync };
}
