// Unchanged pinned X509 wrapper/cache/validation over real native certificates.
function _createNodeX509Platform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ObjectDefineProperty, ObjectGetOwnPropertyDescriptor, ObjectPrototypeHasOwnProperty, Error, JSONParse } = primordials;
    const nativeHandlePrototype = platform.keys.nativeHandlePrototype;
    /* NODE_X509_TRANSLATE_PEER */
    const copyBytes = platform.codecs.copyBytes;
    function legacyBuffers(value) {
        function copy(name) {
            const property = ObjectGetOwnPropertyDescriptor(value, name);
            if (property && property.value !== undefined)
                ObjectDefineProperty(value, name, { value: copyBytes(property.value) });
        }
        copy('pubkey'); copy('raw');
        return value;
    }
    const { ERR_METHOD_NOT_IMPLEMENTED } = platform.values.errors.codes;
    function call(name, ...args) {
        const packet = platform.native.x509Operation(name, ...args);
        if (packet.error !== undefined) {
            throw packet.error;
        }
        return name === 'toLegacy' ? legacyBuffers(packet.value) : packet.value;
    }
    class NativeX509Certificate {
        constructor(input) { return call('create', new.target.prototype, input); }
    }
    for (const name of ['checkCA', 'checkEmail', 'checkHost', 'checkIP', 'checkIssued',
        'checkPrivateKey', 'fingerprint', 'fingerprint256', 'fingerprint512',
        'getIssuerCert', 'infoAccess', 'issuer', 'keyUsage', 'pem', 'raw', 'serialNumber',
        'signatureAlgorithm', 'signatureAlgorithmOid', 'subject', 'subjectAltName',
        'toLegacy', 'validFrom', 'validFromDate', 'validTo', 'validToDate', 'verify']) {
        ObjectDefineProperty(NativeX509Certificate.prototype, name, {
            value: function(...args) {
                const value = call(name, this, ...args);
                return name === 'raw' && value !== undefined ? platform.codecs.copyBytes(value) : value;
            }, writable: true, configurable: true,
        });
    }
    ObjectDefineProperty(NativeX509Certificate.prototype, 'publicKey', {
        value() { return call('publicKey', this, nativeHandlePrototype); }, writable: true, configurable: true,
    });
    const binding = {
        ...call('constants'),
        createX509CertificateClass: callback => callback(NativeX509Certificate),
        isX509Certificate: value => call('is', value),
    };
    const module = { exports: {} };
    function require(name) {
        if (name === 'internal/crypto/keys') return platform.keys;
        if (name === 'internal/util') return platform.values.util;
        if (name === 'internal/util/inspect') return platform.inspection;
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/util/types') return platform.types;
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/tls/common') return { translatePeerCertificate };
        if (name === 'buffer') return { Buffer: platform.Buffer };
        throw new ERR_METHOD_NOT_IMPLEMENTED('X509 dependency ' + name);
    }
    function internalBinding(name) {
        if (name === 'crypto') return binding;
        throw new ERR_METHOD_NOT_IMPLEMENTED('X509 binding ' + name);
    }
    (function(module, exports, require, internalBinding, primordials) {
        /* NODE_X509_MODULE */
    })(module, module.exports, require, internalBinding, primordials);
    return { ...module.exports, nativeHandlePrototype: NativeX509Certificate.prototype,
        legacyCertificate: handle => translatePeerCertificate(call('toLegacy', handle)),
        translatePeerCertificate };
}
