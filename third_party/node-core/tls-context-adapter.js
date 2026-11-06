// Pinned custom-CA validation/configuration over an actual private SSL_CTX.
function _createNodeTlsContextTrust(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayIsArray, ArrayPrototypeForEach } = primordials;
    const { ERR_INVALID_ARG_TYPE } = platform.values.errors.codes;
    const { isArrayBufferView } = platform.types;
    /* NODE_TLS_CA_VALIDATION */
    /* NODE_TLS_ADD_CA_CERTS */
    function create(options) {
        const owner = platform.native.tlsContext('create');
        const context = {
            addCACert(cert) { platform.native.tlsContext('addCA', owner, cert); },
            addRootCerts() { platform.native.tlsContext('addDefault', owner); },
            setAllowPartialTrustChain() { platform.native.tlsContext('partial', owner); },
        };
        const { allowPartialTrustChain, ca } = options;
        const name = 'options';
        /* NODE_TLS_CONFIGURE_CA */
        /* NODE_TLS_PARTIAL_CHAIN */
        return owner;
    }
    return { create };
}
