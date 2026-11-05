// The pinned Node modules own classic stream state, queues and lifetimes.
// Host I/O subclasses supply their actual _read/_write/_destroy operations.
function _createNodeStreamPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { Error, ObjectPrototypeHasOwnProperty, SafeMap,
        Uint8Array, TypedArrayPrototypeSet } = primordials;
    const process = platform.process;
    const modules = new SafeMap([
        ['events', platform.events],
        ['util', platform.util],
        ['buffer', platform.buffer],
        ['fs', platform.fs],
        ['internal/fs/promises', platform.fileHandles],
        ['internal/fs/utils', platform.fsUtils],
        ['internal/url', { toPathIfFileURL: platform.toPathIfFileURL }],
        ['string_decoder', platform.stringDecoder],
        ['async_hooks', platform.async.api],
        ['internal/async_hooks', { enabledHooksExist: platform.async.enabledHooksExist,
            symbols: platform.async.symbols }],
        ['internal/async_context_frame', platform.async.frame],
        ['internal/errors', platform.values.errors],
        ['internal/validators', platform.values.validators],
        ['internal/util', platform.values.util],
        ['internal/util/types', platform.util.types],
        ['internal/util/debuglog', platform.values.require('internal/util/debuglog')],
        ['internal/assert', platform.values.require('internal/assert')],
        ['internal/abort_controller', platform.event.abort],
        ['internal/per_context/domexception', platform.event.dom],
        ['internal/event_target', platform.event.eventTarget],
        ['internal/events/abort_listener', { addAbortListener: platform.event.addAbortListener }],
        ['internal/fixed_queue', platform.event.require('internal/fixed_queue')],
        ['internal/webidl', platform.event.require('internal/webidl')],
        ['internal/worker/js_transferable', platform.clone.protocol],
        ['internal/worker/io', platform.ports],
        ['internal/encoding', { TextEncoder: platform.TextEncoder, TextDecoder: platform.TextDecoder }],
        ['internal/process/task_queues', { queueMicrotask: platform.queueMicrotask }],
        ['internal/buffer', { FastBuffer: platform.FastBuffer }],
        ['internal/options', { getOptionValue(name) {
            if (name === '--experimental-stream-iter') return platform.experimentalStreamIter;
            return unavailable('option ' + name);
        } }],
        ['internal/blob', {
            get Blob() { return platform.getBodyData().Blob; },
            isBlob(value) { return platform.getBodyData().blob(value) !== undefined; },
        }],
    ]);
    const factories = {
        /* NODE_STREAM_MODULES */
    };
    function unavailable(name) {
        const error = new Error('Node stream dependency is not implemented: ' + name);
        error.code = 'ERR_NOT_IMPLEMENTED'; throw error;
    }
    let compressionBinding;
    function internalBinding(name) {
        if (name === 'zlib') return compressionBinding ??= _createNodeCompressionBinding(platform);
        if (name === 'messaging') return platform.event.dom;
        if (name === 'constants') return { zlib: platform.compressionConstants, fs: platform.fs.constants };
        if (name === 'fs') return { handleToFd() { return unavailable('Windows HANDLE import'); } }; // Pinned POSIX guard rejects this platform-specific API.
        if (name === 'buffer') return {
            isUtf8: platform.buffer.isUtf8,
            copyArrayBuffer(target, targetOffset, source, sourceOffset, count) {
                // Callers validate regular, attached buffers and bounds in
                // the pinned algorithm. Copy actual bytes through intrinsics.
                TypedArrayPrototypeSet(new Uint8Array(target, targetOffset, count),
                    new Uint8Array(source, sourceOffset, count));
            },
        };
        if (name === 'util') return {
            constants: { kPending: 0 },
            getPromiseDetails: value => platform.native.getPromiseDetails(value),
            markPromiseAsHandled: value => platform.native.markPromiseAsHandled(value),
        };
        return unavailable('binding ' + name);
    }
    const loading = new SafeMap();
    function require(name) {
        if (loading.has(name)) return loading.get(name).exports;
        if (modules.has(name)) return modules.get(name);
        if (!ObjectPrototypeHasOwnProperty(factories, name)) return unavailable(name);
        const module = { exports: {} };
        loading.set(name, module);
        modules.set(name, module.exports);
        try { factories[name](module, module.exports, require, primordials, internalBinding, process); }
        catch (error) { modules.delete(name); loading.delete(name); throw error; }
        if (name === 'internal/streams/utils') {
            const original = module.exports.isDisturbed;
            module.exports.isDisturbed = function isDisturbed(value) {
                if (platform.webState.isReadable(value)) return platform.webState.isDisturbed(value);
                return original(value);
            };
        }
        modules.set(name, module.exports);
        loading.delete(name);
        return module.exports;
    }
    const api = require('stream');
    const web = require('stream/web');
    const readable = require('internal/webstreams/readablestream');
    const utils = require('internal/streams/utils');
    const { kState } = require('internal/webstreams/util');
    return { api, web, require, webState: {
        isReadable: readable.isReadableStream,
        isLocked: readable.isReadableStreamLocked,
        isDisturbed: value => !!value[utils.kIsDisturbed],
        isByteStream: value => readable.isReadableByteStreamController(value[kState].controller),
    } };
}
