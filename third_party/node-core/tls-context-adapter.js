// Pinned custom-CA validation/configuration over an actual private SSL_CTX.
function _createNodeTlsContextTrust(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayIsArray, ArrayPrototypeFilter, ArrayPrototypeForEach, ArrayPrototypeJoin,
        StringPrototypeSplit, StringPrototypeStartsWith } = primordials;
    const { validateString, validateObject } = platform.values.validators;
    const Buffer = platform.Buffer;
    const { kEmptyObject } = platform.values.require('internal/util');
    /* NODE_TLS_TO_BUF */
    const { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_TLS_INVALID_PROTOCOL_VERSION } = platform.values.errors.codes;
    const { TLS1_VERSION, TLS1_1_VERSION, TLS1_2_VERSION, TLS1_3_VERSION } = platform.constants.crypto;
    function require(name) {
        if (name === 'tls') return platform.require(name);
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('TLS policy dependency ' + name);
    }
    /* NODE_TLS_PROTOCOL_VERSION */
    /* NODE_TLS_GET_DEFAULT_CIPHERS */
    /* NODE_TLS_GET_DEFAULT_ECDH */
    /* NODE_TLS_PROCESS_CIPHERS */
    const { isArrayBufferView } = platform.types;
    /* NODE_TLS_CA_VALIDATION */
    /* NODE_TLS_ADD_CA_CERTS */
    /* NODE_TLS_SET_CERTS */
    /* NODE_TLS_SET_KEY */
    function create(options) {
        options ||= kEmptyObject;
        const tls = require('tls');
        const { minVersion, maxVersion } = options;
        const minV = toV('minimum', minVersion, tls.DEFAULT_MIN_VERSION);
        const maxV = toV('maximum', maxVersion, tls.DEFAULT_MAX_VERSION);
        const owner = platform.native.tlsContext('create', minV, maxV);
        const context = {
            setCipherSuites(value) { platform.native.tlsContext('cipherSuites', owner, value); },
            setCiphers(value) { platform.native.tlsContext('ciphers', owner, value); },
            getMinProto() { return platform.native.tlsContext('getMinProto', owner); },
            getMaxProto() { return platform.native.tlsContext('getMaxProto', owner); },
            setMinProto(value) { platform.native.tlsContext('setMinProto', owner, value); },
            addCACert(cert) { platform.native.tlsContext('addCA', owner, cert); },
            setCert(cert) { platform.native.tlsContext('setCert', owner, cert); },
            setKey(key, passphrase) { platform.native.tlsContext('setKey', owner, key, passphrase); },
            loadPKCS12(...args) { platform.native.tlsContext('loadPFX', owner, ...args); },
            addRootCerts() { platform.native.tlsContext('addDefault', owner); },
            setAllowPartialTrustChain() { platform.native.tlsContext('partial', owner); },
        };
        const name = 'options';
        validateObject(options, name);
        /* NODE_TLS_OPTION_INPUTS */
        /* NODE_TLS_CONFIGURE_CIPHERS */
        /* NODE_TLS_CONFIGURE_CA */
        /* NODE_TLS_PARTIAL_CHAIN */
        /* NODE_TLS_CONFIGURE_CERT */
        /* NODE_TLS_CONFIGURE_KEY */
        /* NODE_TLS_CONFIGURE_PFX */
        return owner;
    }
    return { create };
}
