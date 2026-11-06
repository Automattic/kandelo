// Client method/path setup shares the actual OutgoingMessage private header
// state in production. Header-only dependency controls can install the selected
// pure methods without claiming a transport or public placeholder constructor.
function _createNodeHttpHeaders(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayIsArray, ObjectDefineProperties, ObjectDefineProperty, ObjectGetOwnPropertyDescriptors,
        ObjectKeys, ObjectSetPrototypeOf, ObjectValues, ObjectGetOwnPropertyDescriptor, SafeSet, String, Symbol, Uint8Array } = primordials;
    const { assignFunctionName } = platform.values.util;
    const { hideStackFrames, codes: { ERR_HTTP_HEADERS_SENT, ERR_HTTP_INVALID_HEADER_VALUE,
        ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_INVALID_CHAR, ERR_INVALID_HTTP_TOKEN,
        ERR_UNESCAPED_CHARACTERS } } = platform.values.errors;
    const { validateBoolean, validateObject, validateOneOf, validateString } = platform.values.validators;
    const Buffer = platform.Buffer;
    const debug = platform.values.require('internal/util/debuglog').debuglog('http');
    const OutgoingMessage = { prototype: {} };
    const ClientRequest = OutgoingMessage;
    const kOutHeaders = platform.outgoing ? platform.outgoing.kOutHeaders : Symbol('kOutHeaders');
    const kLenientCache = Symbol('kLenientCache');
    const kUniqueHeaders = platform.outgoing ? platform.outgoing.module.kUniqueHeaders : Symbol('kUniqueHeaders');
    const kPath = Symbol('kPath');
    const isLenient = () => platform.insecureHTTPParser === true;
    /* NODE_HTTP_HEADER_ALGORITHMS */
    function configure(options) {
        /* NODE_HTTP_REQUEST_METHOD */
        /* NODE_HTTP_REQUEST_VALIDATION */
        /* NODE_HTTP_REQUEST_BODY_DEFAULTS */
    }
    function initialize(request, options) {
        request[kOutHeaders] = null;
        request._header = null;
        request._contentLength = null;
        request[kUniqueHeaders] = parseUniqueHeadersOption(options.uniqueHeaders);
        primordials.ReflectApply(configure, request, [options]);
    }
    function serialize(request, firstLine) {
        const state = { connection: false, contLen: false, te: false,
            date: false, expect: false, trailer: false, header: firstLine };
        const headers = request[kOutHeaders];
        const lenient = request._isLenientHeaderValidation();
        if (headers) for (const key of ObjectKeys(headers)) {
            const entry = headers[key];
            processHeader(request, state, entry[0], entry[1], false, lenient);
        }
        return state.header + '\r\n';
    }
    function store(request, firstLine) {
        request._storeHeader(firstLine, request[kOutHeaders]);
    }
    function install(prototype) {
        if (platform.outgoing) {
            // Real framing/header methods are inherited from the unchanged
            // OutgoingMessage; only ClientRequest owns this path accessor.
            ObjectDefineProperty(prototype, 'path', ObjectGetOwnPropertyDescriptor(OutgoingMessage.prototype, 'path'));
        } else ObjectDefineProperties(prototype, ObjectGetOwnPropertyDescriptors(OutgoingMessage.prototype));
    }
    const api = platform.outgoing ? platform.outgoing.module :
        { validateHeaderName, validateHeaderValue, isValidHeaderName, isValidHeaderValue };
    return { initialize, serialize, store, install, STATUS_CODES,
        OutgoingMessage: api.OutgoingMessage,
        validateHeaderName: api.validateHeaderName, validateHeaderValue: api.validateHeaderValue,
        isValidHeaderName: api.isValidHeaderName, isValidHeaderValue: api.isValidHeaderValue };
}
