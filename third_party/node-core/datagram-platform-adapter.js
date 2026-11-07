// Unchanged pinned lib/dgram.js and internal/dgram.js over native guest UDP.
// Handle/ref/queue/async state lives in the native owner, never in host Node.
function _createNodeDatagramPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ObjectDefineProperty, ReflectApply, SafeMap, TypeError,
        TypedArrayPrototypeGetBuffer, TypedArrayPrototypeGetByteOffset,
        TypedArrayPrototypeGetByteLength } = primordials;
    const { ERR_METHOD_NOT_IMPLEMENTED } = platform.values.errors.codes;
    const native = platform.native;
    const operation = (name, ...args) => native.udp(name, ...args);
    const { AF_INET, AF_INET6 } = operation('constants');
    function create(target, fallback, request) {
        if (target === undefined) throw new TypeError('UDP handle requires new');
        const prototype = target.prototype;
        return operation('create', prototype !== null &&
            (typeof prototype === 'object' || typeof prototype === 'function') ? prototype : fallback, request);
    }
    function UDP() { return create(new.target, UDP.prototype, false); }
    function SendWrap() { return create(new.target, SendWrap.prototype, true); }
    const methods = {
        bind(address, port, flags) { return operation('bind', this, address, port, AF_INET, flags); },
        bind6(address, port, flags) { return operation('bind', this, address, port, AF_INET6, flags); },
        connect(address, port) { return operation('connect', this, address, port, AF_INET, 0); },
        connect6(address, port) { return operation('connect', this, address, port, AF_INET6, 0); },
        disconnect() { return operation('disconnect', this); },
        open(fd) { return operation('open', this, fd); },
        getsockname(output) { return operation('name', this, false, output); },
        getpeername(output) { return operation('name', this, true, output); },
        recvStart() {
            return operation('recvStart', this, function(callback, nread, handle, bytes, rinfo) {
                // Native receives own bytes; construct the guest's actual Buffer
                // over that storage without invoking public encoding methods.
                const buffer = nread < 0 ? undefined : new platform.FastBuffer(TypedArrayPrototypeGetBuffer(bytes),
                    TypedArrayPrototypeGetByteOffset(bytes), TypedArrayPrototypeGetByteLength(bytes));
                return ReflectApply(callback, handle, [nread, handle, buffer, rinfo]);
            });
        },
        recvStop() { return operation('recvStop', this); },
        close() { operation('close', this); },
        ref() { operation('ref', this, true); },
        unref() { operation('ref', this, false); },
        hasRef() { return operation('hasRef', this); },
        getSendQueueSize() { return operation('queueSize', this); },
        getSendQueueCount() { return operation('queueCount', this); },
        getAsyncId() { return operation('info', this)[0]; },
        getProviderType() { return platform.async.api.asyncWrapProviders.UDPWRAP; },
        getAsyncContextFrameForDebuggingOnly() { return operation('info', this)[2]; },
        setBroadcast(value) { return operation('option', this, 'broadcast', value); },
        setTTL(value) { return operation('option', this, 'ttl', value); },
        setMulticastTTL(value) { return operation('option', this, 'multicastTTL', value); },
        setMulticastLoopback(value) { return operation('option', this, 'multicastLoopback', value); },
        setMulticastInterface(value) { return operation('multicastInterface', this, value); },
        addMembership(group, selected) { return operation('membership', this, group, selected, undefined, true); },
        dropMembership(group, selected) { return operation('membership', this, group, selected, undefined, false); },
        addSourceSpecificMembership(source, group, selected) { return operation('membership', this, group, selected, source, true); },
        dropSourceSpecificMembership(source, group, selected) { return operation('membership', this, group, selected, source, false); },
        bufferSize(size, receive, context) {
            const result = operation('bufferSize', this, size, receive);
            if (result[0]) {
                context.errno = result[0];
                context.code = platform.uv.getSystemErrorName(result[0]);
                context.message = platform.uv.getSystemErrorMessage(result[0]);
                context.syscall = receive ? 'uv_recv_buffer_size' : 'uv_send_buffer_size';
                return;
            }
            return result[1];
        },
    };
    function send(family, handle, request, list, count, port, address, callback) {
        if (typeof port === 'boolean') return operation('send', handle, request, list, null, 0, family, port, count);
        return operation('send', handle, request, list, address, port, family, callback, count);
    }
    methods.send = function(...args) { return send(AF_INET, this, ...args); };
    methods.send6 = function(...args) { return send(AF_INET6, this, ...args); };
    for (const name of primordials.ObjectKeys(methods))
        ObjectDefineProperty(UDP.prototype, name, { value: methods[name], writable: true, configurable: true, enumerable: true });
    ObjectDefineProperty(UDP.prototype, 'fd', { get() { return operation('fd', this); }, configurable: true });
    const udp = { UDP, SendWrap, constants: { UV_UDP_IPV6ONLY: 1, UV_UDP_REUSEPORT: 64 } };
    const factories = {
        /* NODE_DATAGRAM_MODULES */
    };
    const cache = new SafeMap();
    function require(name) {
        if (cache.has(name)) return cache.get(name).exports;
        if (factories[name] !== undefined) {
            const module = { exports: {} }; cache.set(name, module);
            try { factories[name](module, require, internalBinding, primordials, platform.process); }
            catch (error) { cache.delete(name); throw error; }
            return module.exports;
        }
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/net') return platform.ip;
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/util/types') return platform.types;
        if (name === 'internal/util') return { ...platform.values.require(name),
            promisify: platform.util.promisify, guessHandleType: fd => operation('guess', fd) };
        if (name === 'internal/async_hooks') return { symbols: platform.async.symbols,
            defaultTriggerAsyncIdScope: platform.async.defaultTriggerAsyncIdScope };
        if (name === 'internal/events/abort_listener') return platform.event;
        if (name === 'internal/buffer') return { FastBuffer: platform.FastBuffer };
        if (name === 'internal/blocklist') return platform.addressRules.require(name);
        if (name === 'buffer') return { Buffer: platform.Buffer };
        if (name === 'events') return platform.events;
        if (name === 'dns') return platform.dns;
        if (name === 'cluster') return platform.cluster();
        if (name === 'diagnostics_channel') return platform.diagnostics;
        throw new ERR_METHOD_NOT_IMPLEMENTED(name);
    }
    function internalBinding(name) {
        if (name === 'udp_wrap') return udp;
        if (name === 'uv') return platform.uv.binding;
        if (name === 'constants') return { os: { UV_UDP_REUSEADDR: 4 } };
        throw new ERR_METHOD_NOT_IMPLEMENTED(name);
    }
    return { api: require('dgram'), require };
}
