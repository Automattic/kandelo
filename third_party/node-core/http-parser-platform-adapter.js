// Pinned IncomingMessage callbacks over an opaque native llhttp owner.
// Response events retain their packet contract. Request header decisions enter
// the actual synchronous llhttp frame over the original input allocation;
// body/completion join the same active frame. Full HTTPServer/native consume
// and parser resource/provider lifecycle remain separate.
function _createNodeHttpParser(platform) {
    'use strict';
    const { MathMin, Symbol, ReflectApply, Error, ObjectAssign, ObjectCreate, ObjectDefineProperty, ObjectDefineProperties, ObjectGetOwnPropertyDescriptors, ObjectKeys, TypedArrayPrototypeGetBuffer, TypedArrayPrototypeGetByteOffset, TypedArrayPrototypeGetByteLength } = _createNodePrimordials();
    const { IncomingMessage, readStart, readStop } = platform.incoming;
    const Buffer = platform.Buffer, FastBuffer = platform.FastBuffer;
    // Native event bytes already own an independent copy of parser input.
    // Publish that private storage without public Buffer.from/coercion hooks.
    const bodyBuffer = bytes => new FastBuffer(TypedArrayPrototypeGetBuffer(bytes),
        TypedArrayPrototypeGetByteOffset(bytes), TypedArrayPrototypeGetByteLength(bytes));
    const kIncomingMessage = Symbol('IncomingMessage');
    const kSkipPendingData = Symbol('SkipPendingData');
    /* NODE_HTTP_PARSER_CALLBACKS */
    /* NODE_HTTP_PREPARE_ERROR */
    class ConnectionsList {
        constructor() { return platform.native.httpParser('createConnections', new.target.prototype); }
        all() { return platform.native.httpParser('connectionsAll', this); }
        idle() { return platform.native.httpParser('connectionsIdle', this); }
        active() { return platform.native.httpParser('connectionsActive', this); }
        expired() { return platform.native.httpParser('connectionsExpired', this, arguments[0], arguments[1]); }
    }
    class HTTPClientAsyncResource {
      constructor(type, req) {
        this.type = type;
        this.req = req;
      }
    }

    class HTTPServerAsyncResource {
      constructor(type, socket) {
        this.type = type;
        this.socket = socket;
      }
    }
    const freeListModule = { exports: {} };
    (function(module, exports, primordials) {
        /* NODE_HTTP_FREE_LIST */
    })(freeListModule, freeListModule.exports, _createNodePrimordials());
    // Reuse actual native response storage only. Request wrappers/list identity
    // remain unpooled until the complete public provider/initializer exists.
    const responseOwners = new freeListModule.exports('response parsers', 1000,
        (method, limit, insecure, relaxed) => platform.native.httpParser('create', method, limit, insecure, relaxed));
    let allMethods;
    function makeParser(options, request) {
        if (request) allMethods ??= platform.native.httpParser('allMethods');
        const insecure = options.httpValidation === 'insecure' ||
            (options.httpValidation === undefined && options.insecureHTTPParser === true);
        const method = options.method || 'GET', limit = options.maxHeaderSize || 0;
        const relaxed = options.httpValidation === 'relaxed';
        const owner = request ? platform.native.httpParser('createRequest', method, limit, insecure, relaxed, options.connections)
            : responseOwners.alloc(method, limit, insecure, relaxed);
        let published = false;
        try {
        const resource = request ? new HTTPServerAsyncResource('HTTPINCOMINGMESSAGE', options.socket)
            : new HTTPClientAsyncResource('HTTPINCOMINGMESSAGE', options.outgoing);
        if (!platform.native.httpParser('initialize', owner, method, limit, insecure, relaxed,
            request ? options.connections : undefined, resource)) {
            throw new Error('HTTP parser initialization was retired');
        }
        let message = null, completed = false, failed = false, remainder = null, closed = false;
        let keepAlive = false, upgraded = false;
        const state = {
            incoming: null, _headers: [], _url: '', socket: options.socket,
            maxHeaderPairs: options.maxHeaderPairs ?? MAX_HEADER_PAIRS,
            joinDuplicateHeaders: options.joinDuplicateHeaders,
            onIncoming(incoming, shouldKeepAlive) {
                message = incoming;
                keepAlive = shouldKeepAlive;
                if (request) {
                    const decision = options.onHeaders ? options.onHeaders(incoming) : undefined;
                    return decision === undefined ? (incoming.upgrade ? 2 : 0) : decision;
                }
                if (incoming.upgrade) return 2;
                if (incoming.statusCode >= 100 && incoming.statusCode < 200 && incoming.statusCode !== 101) {
                    if (options.onInformation) options.onInformation({
                        statusCode: incoming.statusCode, statusMessage: incoming.statusMessage,
                        httpVersion: incoming.httpVersion, httpVersionMajor: incoming.httpVersionMajor,
                        httpVersionMinor: incoming.httpVersionMinor, headers: incoming.headers,
                        rawHeaders: incoming.rawHeaders,
                    });
                    return 1;
                }
                if (options.onHeaders) options.onHeaders(incoming);
                if (closed) return 0;
                return options.method === 'HEAD' ? 1 : 0;
            },
        };
        // ConnectionsList returns this same real native request owner, not a
        // different object with copied socket/header metadata.
        const parser = request ? ObjectAssign(owner, state) : state;
        function requestHeaders(event) {
            return dispatch(() => ReflectApply(parserOnHeadersComplete, parser, [event.major, event.minor,
                event.headers, event.method, event.url, event.status, event.statusMessage,
                event.upgrade, event.keepAlive]), true);
        }
        function requestBody(event) {
            const body = bodyBuffer(event.body);
            dispatch(() => ReflectApply(parserOnBody, parser, [body]), false);
        }
        function requestComplete(event) {
            // Native Flush uses MakeCallback for actual trailing headers, then
            // MessageComplete owns its separate skip-task-queues scope.
            if (event.headers.length)
                dispatch(() => ReflectApply(parserOnHeaders, parser, [event.headers, '']), false);
            if (closed) return;
            dispatch(() => {
                ReflectApply(parserOnMessageComplete, parser, []);
                if (!closed && options.onComplete) options.onComplete();
            }, true);
        }
        const dispatch = (callback, skipTasks) => platform.native.httpParser('dispatch', owner, callback, skipTasks);
        function consume(packet, input) {
            if (closed) return;
            if (packet.remainder.length) remainder = Buffer.from(packet.remainder);
            for (let i = 0; i < packet.events.length; ++i) {
                if (closed) return;
                const event = packet.events[i];
                if (event.type === 0) {
                    dispatch(() => ReflectApply(parserOnHeadersComplete, parser, [event.major, event.minor,
                        event.headers, event.request ? event.method : undefined, event.request ? event.url : undefined, event.status, event.statusMessage,
                        event.upgrade, event.keepAlive]), true);
                } else if (event.type === 1) {
                    const body = bodyBuffer(event.body);
                    dispatch(() => ReflectApply(parserOnBody, parser, [body]), false);
                } else if (event.type === 2) {
                    // Use the same trailing-header cap and lifecycle algorithm.
                    if (event.headers.length)
                        dispatch(() => ReflectApply(parserOnHeaders, parser, [event.headers, '']), false);
                    if (closed) return;
                    dispatch(() => {
                        ReflectApply(parserOnMessageComplete, parser, []);
                        if (!closed && !event.informational && options.onComplete) options.onComplete();
                    }, true);
                }
            }
            if (closed) return;
            completed = packet.complete;
            if (packet.code) {
                failed = true;
                const error = new Error('Parse Error');
                error.code = packet.code; error.reason = packet.reason;
                error.bytesParsed = packet.consumed;
                // EOF has no current packet. Never expose a stale native span.
                ReflectApply(prepareError, undefined, [error, { getCurrentBuffer: () => Buffer.alloc(0) }, input]);
                if (options.onError) options.onError(error);
            } else if (packet.upgrade && !upgraded) {
                upgraded = true;
                if (options.onUpgrade) options.onUpgrade(message, remainder || Buffer.alloc(0));
            }
        }
        const api = {
            get message() { return message; },
            get completed() { return completed; },
            get shouldKeepAlive() { return keepAlive; },
            getRemainder() { return remainder; },
            close() {
                if (closed) return;
                closed = true;
                let cleaned = false;
                try {
                    options = null;
                    message = remainder = null;
                    parser.incoming = parser.socket = null;
                    parser._headers = [];
                    parser._url = '';
                    parser.onIncoming = null;
                    parser.joinDuplicateHeaders = null;
                    cleaned = true;
                } finally {
                    if (request || !cleaned) {
                        // Native close is deferred when a real llhttp callback
                        // still owns the frame/input; it never deletes itself.
                        platform.native.httpParser('close', owner);
                    } else {
                        platform.native.httpParser('free', owner);
                        let cached = false;
                        try { cached = responseOwners.free(owner); }
                        finally { if (!cached) platform.native.httpParser('close', owner); }
                    }
                }
            },
            feed(bytes) {
                if (closed || failed || completed) return;
                consume(request ? platform.native.httpParser('feedRequest', owner, bytes, requestHeaders, requestBody, requestComplete)
                    : platform.native.httpParser('feed', owner, bytes), bytes);
            },
            end() {
                if (closed || failed || completed) return;
                consume(request ? platform.native.httpParser('finishRequest', owner, undefined, requestHeaders, requestBody, requestComplete)
                    : platform.native.httpParser('finish', owner));
            },
        };
        if (!request) { published = true;return api; }
        const descriptors = ObjectGetOwnPropertyDescriptors(api);
        const names = ObjectKeys(descriptors);
        for (let i = 0; i < names.length; ++i)
            descriptors[names[i]] = ObjectAssign(ObjectCreate(null), descriptors[names[i]]);
        ObjectDefineProperties(owner, descriptors);
        ObjectDefineProperty(owner, 'remove', { __proto__: null,
            value: function remove() { return platform.native.httpParser('remove', owner); },
            writable: true, enumerable: true, configurable: true });
        published = true;
        return owner;
        } finally {
            // Getter/descriptor/allocation failure before returning a parser
            // does not strand an actual pooled/listed owner.
            if (!published) platform.native.httpParser('close', owner);
        }
    }
    function makeResponseParser(options) { return makeParser(options, false); }
    makeResponseParser.request = options => makeParser(options, true);
    makeResponseParser.ConnectionsList = ConnectionsList;
    makeResponseParser.kIncomingMessage = kIncomingMessage;
    return makeResponseParser;
}
