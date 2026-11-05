// Shared outgoing-header state for actual HTTP/HTTPS requests. These pinned
// algorithms do not supply the missing full OutgoingMessage/framing/parser,
// Agent or server owners; no public placeholder constructor is created.
function _createNodeHttpHeaders(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayIsArray, ObjectDefineProperties, ObjectDefineProperty, ObjectGetOwnPropertyDescriptors,
        ObjectKeys, ObjectSetPrototypeOf, ObjectValues, SafeSet, String, Symbol, Uint8Array } = primordials;
    const { assignFunctionName } = platform.values.util;
    const { hideStackFrames, codes: { ERR_HTTP_HEADERS_SENT, ERR_HTTP_INVALID_HEADER_VALUE,
        ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_INVALID_CHAR, ERR_INVALID_HTTP_TOKEN,
        ERR_UNESCAPED_CHARACTERS } } = platform.values.errors;
    const { validateBoolean, validateObject, validateOneOf, validateString } = platform.values.validators;
    const Buffer = platform.Buffer;
    const debug = platform.values.require('internal/util/debuglog').debuglog('http');
    const OutgoingMessage = { prototype: {} };
    const ClientRequest = OutgoingMessage;
    const kOutHeaders = Symbol('kOutHeaders');
    const kLenientCache = Symbol('kLenientCache');
    const kUniqueHeaders = Symbol('kUniqueHeaders');
    const kPath = Symbol('kPath');
    const isLenient = () => platform.insecureHTTPParser === true;
    /* NODE_HTTP_HEADER_ALGORITHMS */
    function configure(options) {
        /* NODE_HTTP_REQUEST_METHOD */
        /* NODE_HTTP_REQUEST_VALIDATION */
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
    function install(prototype) {
        ObjectDefineProperties(prototype, ObjectGetOwnPropertyDescriptors(OutgoingMessage.prototype));
    }
    return { initialize, serialize, install, STATUS_CODES,
        validateHeaderName, validateHeaderValue, isValidHeaderName, isValidHeaderValue };
}
