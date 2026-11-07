// Pinned ServerResponse uses the existing real OutgoingMessage and socket
// ownership. Full Server/connection tracking/parser admission remains separate.
function _createNodeHttpServerResponse(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayIsArray, ObjectKeys, ObjectSetPrototypeOf, Symbol } = primordials;
    const { OutgoingMessage, validateHeaderName, validateHeaderValue } = platform.outgoing.module;
    const kOutHeaders = platform.outgoing.kOutHeaders;
    const { getRawHeader } = platform.incoming;
    const { hasObserver, startPerf, stopPerf } = platform.observation;
    const { categoryEnabledChecker, trace, nodeTraceEventCategory, kAsyncBegin, kAsyncEnd } = platform.trace;
    const { codes: { ERR_HTTP_HEADERS_SENT, ERR_HTTP_INVALID_STATUS_CODE,
        ERR_HTTP_SOCKET_ASSIGNED, ERR_INVALID_ARG_VALUE, ERR_INVALID_CHAR } } = platform.values.errors;
    const { validateInteger, validateObject, validateLinkHeaderValue } = platform.values.validators;
    const assert = platform.assert;
    const STATUS_CODES = platform.STATUS_CODES;
    const kServerResponseStatistics = Symbol('ServerResponseStatistics');
    const statusLineCache = [];
    const HTTP_SERVER_TRACE_EVENT_NAME = 'http.server.request';
    const onResponseCreatedChannel = platform.diagnostics.registerProducer('http.server.response.created');
    /* NODE_HTTP_SERVER_PREDICATES */
    const { chunkExpression } = {
        /* NODE_HTTP_SERVER_CHUNK_EXPRESSION */
    };
    /* NODE_HTTP_SERVER_TRACE */
    /* NODE_HTTP_SERVER_RESPONSE */
    /* NODE_HTTP_SERVER_CLOSE */
    return { ServerResponse };
}
