// Pinned Undici Response, Request and Body algorithms share actual stream, header-list,
// FormData, Blob/File and abort owners. HTTP transport remains its own owner.
function _createNodeFetchBodyPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { SafeMap, ObjectPrototypeHasOwnProperty, Error } = primordials;
    const { ReflectApply, SymbolAsyncIterator, Uint8Array, TypeError,
        TypedArrayPrototypeGetByteLength, TypedArrayPrototypeSet,
        PromiseResolve, PromiseReject, PromisePrototypeThen } = primordials;
    const { Buffer, Blob, File, URL, URLSearchParams, AbortController, TextEncoder, TextDecoder, TextDecoderStream, process } = platform;
    const { ReadableStream, TransformStream } = platform.stream.web;
    const { isReadable: isReadableStream, finished: streamFinished } = platform.stream.api;
    const requireStream = platform.stream.require;
    const argumentLengthCheck = platform.formData.webidl.argumentLengthCheck;
    const factories = {
        __proto__: null,
        /* NODE_FETCH_BODY_MODULES */
    };
    const modules = new SafeMap();
    function require(name, from) {
        if (name === 'node:assert') return platform.assert;
        if (name === 'node:util') return platform.util;
        if (name === 'node:events') return platform.events;
        if (name === 'node:stream') return platform.stream.api;
        if (name === 'node:stream/web') return platform.stream.web;
        if (name === './headers') return platform.formData.headers;
        if (name === '../../core/symbols') return platform.formData.coreSymbols;
        if (name === 'node:util/types') return platform.types;
        if (name === './formdata') return platform.formData;
        if (name === '../webidl') return { webidl: platform.formData.webidl };
        if (name === '../../core/util') return { ...require('corePrimitive'),
            isDisturbed: platform.stream.api.isDisturbed,
            kEnumerableProperty: platform.values.util.kEnumerableProperty };
        const id = name === './data-url' ? 'dataURL' : name === '../infra' ? 'infra' :
            name === './formdata-parser' ? 'multipart' : name === './util' ? 'util' :
            name === '../../encoding' ? 'encoding' : name === './tree' ? 'tree' :
            name === './constants' ? (from === 'tree' ? 'coreConstants' : 'fetchConstants') :
            name === './global' ? 'globalOrigin' : name === './body' ? 'body' : name;
        if (modules.has(id)) return modules.get(id).exports;
        if (!ObjectPrototypeHasOwnProperty(factories, id)) {
            const error = new Error('Unsupported Fetch Body dependency: ' + name);
            error.code = 'ERR_NOT_IMPLEMENTED'; throw error;
        }
        const module = { exports: {} };
        modules.set(id, module);
        try { factories[id](module, module.exports, name => require(name, id)); }
        catch (error) { modules.delete(id); throw error; }
        return module.exports;
    }
    const body = require('body');
    const response = require('response');
    // Data URLs own decoded bytes, not a network connection. Share the pinned
    // decoder, MIME, Body and Response records; cancellation must reach their
    // actual stream controller even while a reader or tee owns its lock.
    async function fetchDataURL(requestObject) {
        const request = require('request').getRequestState(requestObject);
        const signal = requestObject.signal;
        const { dataURLProcessor, serializeAMimeType } = require('dataURL');
        const { addAbortListener } = require('corePrimitive');
        const { kState } = requireStream('internal/webstreams/util');
        const { readableStreamDefaultControllerError } =
            requireStream('internal/webstreams/readablestream');
        let removeAbortListener, responseBody, aborted = false, reason;
        function cleanup() {
            removeAbortListener?.();
            removeAbortListener = undefined;
            require('request').removeRequestAbortListener(requestObject);
        }
        function abort() {
            aborted = true;
            reason = signal.reason;
            try {
                if (request.body?.stream != null && isReadableStream(request.body.stream)) {
                    PromisePrototypeThen(request.body.stream.cancel(reason), undefined, error => {
                        if (error.code !== 'ERR_INVALID_STATE') throw error;
                    });
                }
                if (responseBody !== null && responseBody !== undefined &&
                    isReadableStream(responseBody.stream)) {
                    readableStreamDefaultControllerError(
                        responseBody.stream[kState].controller, reason);
                }
            } finally { cleanup(); }
        }
        if (signal.aborted) { abort(); throw reason; }
        removeAbortListener = addAbortListener(signal, abort);
        try {
            const url = request.urlList[request.urlList.length - 1];
            const decoded = dataURLProcessor(url);
            let error;
            if (decoded === 'failure') {
                error = new TypeError('fetch failed', {
                    cause: response.makeNetworkError('failed to fetch the data URL').error,
                });
            } else if (request.integrity) {
                // Integrity requires the genuine SRI/hash-policy owner. Do not
                // publish unchecked bytes as an integrity-verified response.
                error = new Error('Fetch subresource integrity is not implemented');
                error.code = 'ERR_NOT_IMPLEMENTED';
            } else {
                responseBody = request.method === 'HEAD' ? null : body.extractBody(decoded.body)[0];
            }
            // Scheme fetch and response publication cross a job boundary in
            // Undici. A same-stack abort must still win before publication.
            await PromiseResolve();
            if (aborted) throw reason;
            if (error !== undefined) throw error;
            const inner = response.makeResponse({
                statusText: 'OK',
                headersList: [['content-type', {
                    name: 'Content-Type', value: serializeAMimeType(decoded.mimeType),
                }]],
                body: responseBody,
                urlList: request.urlList,
            });
            const result = response.fromInnerResponse(response.filterResponse(inner, 'basic'), 'immutable');
            if (responseBody === null) { request.done = true; cleanup(); }
            else streamFinished(responseBody.stream, () => {
                request.done = true;
                cleanup();
            });
            return result;
        } catch (error) { cleanup(); throw error; }
    }
    // Pinned Undici HTTP-network body demand/termination contract over the
    // actual IncomingMessage owner; full dispatcher/fetch policy is separate.
    const readablePrototype = platform.stream.api.Readable.prototype;
    const incomingIterator = readablePrototype[SymbolAsyncIterator];
    const destroyIncoming = readablePrototype.destroy;
    const { isErrorLike, readableStreamClose } = require('util');
    const isUint8Array = platform.types.isUint8Array;
    function responseBodyFromIncoming(incoming, options) {
        const iterator = ReflectApply(incomingIterator, incoming, []);
        let controller, terminal = false, demand = null, released = false, releaseResult;
        const noop = () => {};
        function releaseIterator() {
            if (released) return releaseResult;
            released = true;
            try { releaseResult = PromiseResolve(ReflectApply(iterator.return, iterator, [])); }
            catch (error) { releaseResult = PromiseReject(error); }
            // Error/abort already owns its exact terminal reason. Cancellation
            // still returns this actual cleanup promise to its caller.
            PromisePrototypeThen(releaseResult, noop, noop);
            return releaseResult;
        }
        function detach() {
            incoming.removeListener('error', onError);
            incoming.removeListener('close', onClose);
        }
        function stop(reason, aborted, canceled) {
            if (terminal) return releaseResult;
            terminal = true;
            // Fetch.abort destroys its real connection before publishing the
            // controller error. Every owned retirement runs even when another
            // cleanup step or the reflectable publication hook throws.
            try {
                try { ReflectApply(destroyIncoming, incoming, [reason]); }
                finally { options.onCancel(reason); }
            } finally {
                try { options.onTerminal(); }
                finally { releaseIterator(); }
            }
            if (!canceled) controller.error(aborted ? reason : new TypeError('terminated', {
                cause: isErrorLike(reason) ? reason : undefined,
            }));
            return releaseResult;
        }
        function onError(error) { stop(error, false, false); }
        function onClose() {
            if (!terminal && !incoming.readableEnded)
                stop(new platform.values.errors.codes.ERR_STREAM_PREMATURE_CLOSE(), false, false);
            detach();
        }
        const stream = new ReadableStream({
            type: 'bytes',
            start(value) { controller = value; },
            async pull() {
                if (terminal) return;
                const ticket = {};
                let publishingEof = false;
                demand = ticket;
                try {
                    while (!terminal && demand === ticket) {
                        const result = await iterator.next();
                        if (terminal || demand !== ticket) return;
                        if (result.done) {
                            terminal = true;
                            publishingEof = true;
                            try { readableStreamClose(controller); }
                            finally {
                                try { options.onTerminal(); }
                                finally { releaseIterator(); }
                            }
                            return;
                        }
                        const bytes = result.value;
                        if (!isUint8Array(bytes))
                            throw new TypeError('Response body chunk must be a Uint8Array');
                        const length = TypedArrayPrototypeGetByteLength(bytes);
                        if (length !== 0) {
                            // The byte controller transfers/detaches this fresh
                            // allocation, never an IncomingMessage Buffer pool.
                            const independent = new Uint8Array(length);
                            TypedArrayPrototypeSet(independent, bytes, 0);
                            controller.enqueue(independent);
                        }
                        if (controller.desiredSize <= 0) return;
                    }
                } catch (error) {
                    // A close/publication hook failure must reject this pull
                    // with its original identity, as pinned Undici resume does.
                    if (publishingEof) throw error;
                    if (!terminal) stop(error, false, false);
                } finally {
                    if (demand === ticket) demand = null;
                }
            },
            cancel(reason) { return stop(reason, true, true); },
        });
        // No data listener: the real classic readable iterator drives its
        // _read/readStart and bounded readable-buffer/native pause lifecycle.
        incoming.on('error', onError);
        incoming.on('close', onClose);
        return { stream,
            abort(reason) { return stop(reason, true, false); },
            error(reason) { return stop(reason, false, false); },
        };
    }

    return { ...body, ...response, ...require('request'), responseBodyFromIncoming, fetchDataURL,
        argumentLengthCheck, isFormData: platform.formData.webidl.is.FormData };
}
