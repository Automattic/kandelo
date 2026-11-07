// Pinned stream read/write delivery over the genuine native TCP owner.
function _createNodeSocketStream(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { Symbol, ReflectApply } = primordials;
    const { Buffer, FastBuffer } = platform;
    const { owner_symbol } = platform.async.symbols;
    const { ErrnoException } = platform.values.errors;
    const { isUint8Array } = platform.types;
    // These fields are written from actual delivered native material. No raw
    // descriptor or Promise fulfillment is used as an idle/read-state proxy.
    /* NODE_SOCKET_STREAM_STATE_LAYOUT */
    const UV_EOF = -4095;
    function require(name) {
        if (name === 'internal/util/debuglog') return platform.values.require(name);
        throw new primordials.Error('Unsupported socket stream dependency: ' + name);
    }
    /* NODE_SOCKET_STREAM_SYMBOLS */
    /* NODE_SOCKET_STREAM_AFTER_WRITE */
    /* NODE_SOCKET_STREAM_READ */
    const kSetNoDelay = Symbol('kSetNoDelay'), kSetKeepAlive = Symbol('kSetKeepAlive');
    const kSetKeepAliveInitialDelay = Symbol('kSetKeepAliveInitialDelay');
    const kSetKeepAliveInterval = Symbol('kSetKeepAliveInterval'), kSetKeepAliveCount = Symbol('kSetKeepAliveCount');
    // Generic callable Socket construction initializes the actual inheriting
    // receiver. A temporary constructed Socket cannot carry this ownership.
    function createConstructor(prototype, prepareOwner, initializeOwner, finishOwner) {
        const stream = platform.stream;
        const { ObjectDefineProperty, ObjectSetPrototypeOf } = primordials;
        const { ERR_INVALID_ARG_VALUE } = platform.values.errors.codes;
        const { validateNumber } = platform.values.validators;
        function Socket(options) {
            if (!(this instanceof Socket)) return new Socket(options);
            // Transfer remains disabled until the actual native owner can move.
            platform.markResource(this);
            /* NODE_SOCKET_CONSTRUCTOR_VALIDATE */
            prepareOwner(this);
            /* NODE_SOCKET_CONSTRUCTOR_NORMALIZE */
            initializeOwner(this, options);
            // The admitted kinds here are actual TCP resources, not BoundSocket
            // wrappers. BoundSocket/TTY/Pipe admission remains separate work.
            const boundNotConnected = false;
            /* NODE_SOCKET_CONSTRUCTOR_FLOW */
            finishOwner(this, options);
        }
        Socket.prototype = prototype;
        ObjectDefineProperty(Socket.prototype, 'constructor', {
            value: Socket, writable: true, configurable: true,
        });
        ObjectSetPrototypeOf(Socket.prototype, stream.Duplex.prototype);
        ObjectSetPrototypeOf(Socket, stream.Duplex);
        return Socket;
    }
    function installSocket(Socket) {
        /* NODE_SOCKET_NET_OPTIONS */
    }
    function initOptions(socket, options) {
        ReflectApply(function() {
            /* NODE_SOCKET_NET_INIT */
        }, socket, []);
    }
    function applyOptions(self) {
        /* NODE_SOCKET_NET_APPLY */
    }
    function bind(owner, stream) {
        owner[owner_symbol] = stream;
        owner.reading = false;
        owner.onread = onStreamRead;
        owner.configureRead(function(_status, buffer, onread) {
            if (typeof onread !== 'function') throw new primordials.TypeError('TCP onread must be callable');
            return ReflectApply(onread, this, [buffer]);
        }, streamBaseState);
        const nativeWrite = owner.write;
        owner.writeBuffer = function(_request, buffer) {
            return ReflectApply(nativeWrite, this, [buffer]);
        };
        const nativeWriteVector = owner.writeVector;
        owner.writev = function(_request, chunks, allBuffers) {
            if (allBuffers !== true) {
                const error = new primordials.Error('Mixed string TCP vectors require their native encoding owner');
                error.code = 'ERR_NOT_IMPLEMENTED'; throw error;
            }
            return ReflectApply(nativeWriteVector, this, [chunks]);
        };
        stream[kUpdateTimer] = stream._unrefTimer;
        stream[kAfterAsyncWrite] = function() { this._lastWriteQueueSize = 0; };
        return owner;
    }
    return { bind, onStreamRead, afterWriteDispatched, createConstructor, installSocket, initOptions, applyOptions,
        binding: { kReadBytesOrError, kArrayBufferOffset, kBytesWritten, kLastWriteWasAsync, kLastWriteErr, streamBaseState },
        symbols: { kUpdateTimer, kAfterAsyncWrite, kHandle, kMaybeDestroy } };
}
