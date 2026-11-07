// Pinned custom-CA validation/configuration over an actual private SSL_CTX.
function _createNodeTlsContextTrust(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayIsArray, ArrayPrototypeForEach } = primordials;
    const { validateString } = platform.values.validators;
    const Buffer = platform.Buffer;
    /* NODE_TLS_TO_BUF */
    const { ERR_INVALID_ARG_TYPE } = platform.values.errors.codes;
    const { isArrayBufferView } = platform.types;
    /* NODE_TLS_CA_VALIDATION */
    /* NODE_TLS_ADD_CA_CERTS */
    /* NODE_TLS_SET_CERTS */
    /* NODE_TLS_SET_KEY */
    function create(options) {
        const owner = platform.native.tlsContext('create');
        const context = {
            addCACert(cert) { platform.native.tlsContext('addCA', owner, cert); },
            setCert(cert) { platform.native.tlsContext('setCert', owner, cert); },
            setKey(key, passphrase) { platform.native.tlsContext('setKey', owner, key, passphrase); },
            loadPKCS12(...args) { platform.native.tlsContext('loadPFX', owner, ...args); },
            addRootCerts() { platform.native.tlsContext('addDefault', owner); },
            setAllowPartialTrustChain() { platform.native.tlsContext('partial', owner); },
        };
        const { allowPartialTrustChain, ca, cert, key, passphrase, pfx } = options;
        const name = 'options';
        /* NODE_TLS_CONFIGURE_CA */
        /* NODE_TLS_PARTIAL_CHAIN */
        /* NODE_TLS_CONFIGURE_CERT */
        /* NODE_TLS_CONFIGURE_KEY */
        /* NODE_TLS_CONFIGURE_PFX */
        return owner;
    }
    return { create };
}
