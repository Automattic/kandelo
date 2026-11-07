// Pinned IncomingMessage callbacks over an opaque native llhttp owner.
// Native events own their bytes. Synchronous JS callback/reentry equivalence
// during llhttp_execute remains a separate obligation of this packet bridge.
function _createNodeHttpParser(platform) {
    'use strict';
    const { MathMin, Symbol, ReflectApply, Error } = _createNodePrimordials();
    const { IncomingMessage, readStart, readStop } = platform.incoming;
    const Buffer = platform.Buffer;
    const kIncomingMessage = Symbol('IncomingMessage');
    const kSkipPendingData = Symbol('SkipPendingData');
    /* NODE_HTTP_PARSER_CALLBACKS */
    /* NODE_HTTP_PREPARE_ERROR */
    let allMethods;
    function makeParser(options, request) {
        if (request) allMethods ??= platform.native.httpParser('allMethods');
        const insecure = options.httpValidation === 'insecure' ||
            (options.httpValidation === undefined && options.insecureHTTPParser === true);
        const owner = platform.native.httpParser(request ? 'createRequest' : 'create', options.method || 'GET',
            options.maxHeaderSize || 0, insecure, options.httpValidation === 'relaxed');
        let message = null, completed = false, failed = false, remainder = null;
        let keepAlive = false, upgraded = false;
        const parser = {
            incoming: null, _headers: [], _url: '', socket: options.socket,
            maxHeaderPairs: options.maxHeaderPairs ?? MAX_HEADER_PAIRS,
            joinDuplicateHeaders: options.joinDuplicateHeaders,
            onIncoming(incoming, shouldKeepAlive) {
                message = incoming;
                keepAlive = shouldKeepAlive;
                if (incoming.upgrade) return 2;
                if (request) {
                    if (options.onHeaders) options.onHeaders(incoming);
                    return 0;
                }
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
                return options.method === 'HEAD' ? 1 : 0;
            },
        };
        function consume(packet, input) {
            if (packet.remainder.length) remainder = Buffer.from(packet.remainder);
            for (let i = 0; i < packet.events.length; ++i) {
                const event = packet.events[i];
                if (event.type === 0) {
                    ReflectApply(parserOnHeadersComplete, parser, [event.major, event.minor,
                        event.headers, event.request ? event.method : undefined, event.request ? event.url : undefined, event.status, event.statusMessage,
                        event.upgrade, event.keepAlive]);
                } else if (event.type === 1) {
                    ReflectApply(parserOnBody, parser, [Buffer.from(event.body)]);
                } else if (event.type === 2) {
                    // Use the same trailing-header cap and lifecycle algorithm.
                    ReflectApply(parserOnHeaders, parser, [event.headers, '']);
                    ReflectApply(parserOnMessageComplete, parser, []);
                    if (!event.informational && options.onComplete) options.onComplete();
                }
            }
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
        return {
            get message() { return message; },
            get completed() { return completed; },
            get shouldKeepAlive() { return keepAlive; },
            getRemainder() { return remainder; },
            feed(bytes) {
                if (failed || completed) return;
                consume(platform.native.httpParser('feed', owner, bytes), bytes);
            },
            end() {
                if (failed || completed) return;
                consume(platform.native.httpParser('finish', owner));
            },
        };
    }
    function makeResponseParser(options) { return makeParser(options, false); }
    makeResponseParser.request = options => makeParser(options, true);
    makeResponseParser.kIncomingMessage = kIncomingMessage;
    return makeResponseParser;
}
