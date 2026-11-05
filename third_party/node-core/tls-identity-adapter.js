// Independently callable certificate identity validation. Chain verification,
// certificate extraction, SecureContext and socket lifecycle retain their own
// native owners; installing this function does not replace those contracts.
function _createNodeTlsIdentity(platform) {
    'use strict';
    const { ArrayIsArray, JSONParse, StringFromCharCode } = _createNodePrimordials();
    const { ERR_TLS_CERT_ALTNAME_FORMAT, ERR_TLS_CERT_ALTNAME_INVALID } = platform.values.errors.codes;
    const { net, domainToASCII, canonicalizeIP } = platform;
    const exports = {};
    /* NODE_TLS_IDENTITY */
    return exports.checkServerIdentity;
}
