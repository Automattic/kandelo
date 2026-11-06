// Complete pinned OutgoingMessage owns real HTTP byte queues and socket writes.
// No host HTTP transport, replacement Writable, or fake completion is supplied.
function _createNodeHttpOutgoing(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { Date, Symbol, Uint8Array } = primordials;
    const process = platform.process;
    const setUnrefTimeout = platform.setUnrefTimeout;
    /* NODE_HTTP_OUTGOING_PREDICATES */
    /* NODE_HTTP_OUTGOING_DATE */
    const state = { kOutHeaders: Symbol('kOutHeaders'), kNeedDrain: Symbol('kNeedDrain'), utcDateHeader };
    const common = { _checkIsHttpToken: checkIsHttpToken,
        _checkInvalidHeaderChar: checkInvalidHeaderChar,
        /* NODE_HTTP_OUTGOING_CHUNK_EXPRESSION */
        isLenient: () => platform.insecureHTTPParser === true };
    function require(name) {
        if (name === 'internal/streams/state') return platform.streamsState;
        if (name === 'internal/assert') return platform.assert;
        if (name === 'events') return platform.events;
        if (name === 'stream') return platform.stream;
        if (name === 'internal/http') return state;
        if (name === 'buffer') return { Buffer: platform.Buffer };
        if (name === '_http_common') return common;
        if (name === 'internal/async_hooks') return platform.async;
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/util') return platform.values.util;
        if (name === 'internal/util/types') return platform.types;
        if (name === 'internal/util/debuglog') return platform.values.require(name);
        throw new primordials.Error('Unsupported OutgoingMessage dependency: ' + name);
    }
    const module = { exports: {} };
    (function(module, exports, require, primordials, process) {
        /* NODE_HTTP_OUTGOING_MODULE */
    })(module, module.exports, require, primordials, process);
    const { kNeedDrain } = state;
    /* NODE_HTTP_OUTGOING_DRAIN */
    return { module: module.exports, kOutHeaders: state.kOutHeaders, onSocketDrain: ondrain };
}
