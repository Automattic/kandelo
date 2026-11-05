// Real local endpoint transport. Native queues own serialized packets and loop
// reference/close state. Worker/bootstrap/port movement are separate owners.
function _createNodePortsPlatform(platform) {
    'use strict';
    const P = _createNodePrimordials();
    const { ArrayIsArray, ArrayPrototypePush, ObjectCreate, ObjectDefineProperty,
        ReflectApply, SafeMap, SafeSet, SafeWeakMap, Symbol, SymbolIterator, WeakRef, uncurryThis } = P;
    const deref = uncurryThis(WeakRef.prototype.deref);
    const states = new SafeWeakMap(), registry = new SafeSet(), roots = new SafeSet();
    const symbols = { oninit: Symbol('oninit'), handle_onclose: Symbol('handle_onclose'), no_message_symbol: Symbol('no_message') };
    const codes = platform.values.errors.codes;
    const { process } = platform;
    const native = (operation, owner, value) => platform.native.port(operation, owner, value);
    const nativeErrorMessages = /* NODE_PORT_NATIVE_ERRORS */;
    let io;
    function constructorError(code) { const error = new P.TypeError(nativeErrorMessages[code]); error.code = code; throw error; }
    function unavailable(name) { const error = new Error(name + ' is not implemented'); error.code = 'ERR_NOT_IMPLEMENTED'; throw error; }
    function state(port) { const value = states.get(port); if (!value) throw new codes.ERR_INVALID_THIS('MessagePort'); return value; }
    function iterable(value, output) {
        if (ArrayIsArray(value)) {
            const length = value.length;
            for (let i = 0; i < length; i++) ArrayPrototypePush(output, value[i]);
            return true;
        }
        if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
        const method = value[SymbolIterator];
        if (method === undefined || method === null) return false;
        const once = { [SymbolIterator]() { return ReflectApply(method, value, []); } };
        for (const entry of once) ArrayPrototypePush(output, entry);
        return true;
    }
    function transferList(value) {
        const result = [];
        if (value === null || value === undefined) return result;
        if ((typeof value !== 'object' && typeof value !== 'function'))
            throw new codes.ERR_INVALID_ARG_TYPE('transferList', 'Iterable', value);
        if (!iterable(value, result)) {
            const transfer = value.transfer;
            if (transfer !== undefined && !iterable(transfer, result))
                throw new codes.ERR_INVALID_ARG_TYPE('options.transfer', 'Iterable', transfer);
        }
        return result;
    }
    function MessagePort() { constructorError('ERR_CONSTRUCT_CALL_INVALID'); }
    const methods = {
        postMessage(value, transfer) {
            const owner = state(this);
            if (arguments.length === 0) throw new codes.ERR_MISSING_ARGS('value');
            // Serialization and transfer validation still run for closed ports.
            // The engine owns graph identity/getters and byte detachment now;
            // deserialization remains deferred until receive/delivery.
            const serialized = platform.native.serializeMessage(value, transferList(transfer));
            return native('post', owner.handle, serialized);
        },
        start() { native('start', state(this).handle, true); },
        ref() { const owner = state(this); if (!owner.closed && !owner.closing) { native('ref', owner.handle, true); roots.add(this); } return this; },
        unref() { const owner = state(this); if (!owner.closed && !owner.closing) { native('ref', owner.handle, false); roots.delete(this); } return this; },
        hasRef() { return native('hasRef', state(this).handle); },
        close() {
            const owner = state(this);
            if (owner.closed || owner.closing) return;
            native('close', owner.handle); owner.closing = true;
            // Closing is a real pending native transition, even on an unref port.
            roots.add(this);
        },
    };
    for (const name of ['postMessage', 'start', 'ref', 'unref', 'hasRef', 'close'])
        ObjectDefineProperty(MessagePort.prototype, name, { value: methods[name], configurable: true, writable: true, enumerable: true });
    function wrap(handle) {
        const port = ObjectCreate(MessagePort.prototype);
        const weak = new WeakRef(port);
        const resource = new platform.AsyncResource('MESSAGEPORT');
        states.set(port, { handle, weak, resource, closed: false, closing: false });
        registry.add(weak);
        // Port host-handle transfer is not implemented. Do not advertise a
        // successful transfer mode until movement owns the endpoint itself.
        platform.markUncloneable(port);
        ReflectApply(port[symbols.oninit], port, []);
        return port;
    }
    function MessageChannel() {
        if (!new.target) constructorError('ERR_CONSTRUCT_CALL_REQUIRED');
        const handles = native('pair');
        try {
            const port1 = wrap(handles[0]), port2 = wrap(handles[1]);
            for (const [name, port] of [['port1', port1], ['port2', port2]])
                ObjectDefineProperty(this, name, { value: port, configurable: true, writable: true, enumerable: true });
        } catch (error) { native('close', handles[0]); native('close', handles[1]); throw error; }
    }
    function receive(port, force, dispatch) {
        const owner = state(port);
        if (owner.closed) return symbols.no_message_symbol;
        const packet = native('receive', owner.handle, force);
        if (packet === undefined) return symbols.no_message_symbol;
        if (packet === null) {
            if (!dispatch) { owner.closing = true; roots.add(port); return symbols.no_message_symbol; }
            native('ackClose', owner.handle);
            owner.closed = true; owner.closing = false;
            roots.delete(port); registry.delete(owner.weak);
            try { owner.resource.runInAsyncScope(port[symbols.handle_onclose], port); }
            finally { owner.resource.emitDestroy(); }
            return symbols.no_message_symbol;
        }
        let value;
        try { value = platform.native.deserializeMessage(packet); }
        catch (error) {
            if (!dispatch) throw error;
            owner.resource.runInAsyncScope(emitMessage, port, error, undefined, 'messageerror');
            return true;
        }
        if (!dispatch) return value;
        owner.resource.runInAsyncScope(emitMessage, port, value, [], 'message');
        return true;
    }
    let emitMessage;
    function initialize(stream) {
        if (io) return io;
        const factories = { /* NODE_PORT_MODULES */ };
        const modules = new SafeMap();
        function require(name) {
            if (name === 'internal/util') return platform.values.util;
            if (name === 'internal/errors') return platform.values.errors;
            if (name === 'internal/event_target') return platform.eventTarget;
            if (name === 'internal/util/inspect') return platform.inspection;
            if (name === 'stream') return stream;
            if (name === 'internal/deps/undici/undici') return platform.getMessageEvents();
            if (modules.has(name)) return modules.get(name).exports;
            const module = { exports: {} }; modules.set(name, module);
            try { factories[name](module, module.exports, require, P, internalBinding, process); }
            catch (error) { modules.delete(name); throw error; }
            return module.exports;
        }
        function internalBinding(name) {
            if (name === 'symbols') return symbols;
            if (name === 'util') return { privateSymbols: platform.clone.privateSymbols, constants: { kCloneable: 2 } };
            if (name === 'worker') return { getEnvMessagePort: () => unavailable('Worker environment message port') };
            if (name === 'messaging') return {
                MessagePort, MessageChannel, DOMException: platform.DOMException,
                markAsUncloneable: object => platform.native.objectMark('clone', object),
                receiveMessageOnPort: port => receive(port, true, false),
                stopMessagePort: port => native('start', state(port).handle, false),
                drainMessagePort: port => { while (receive(port, true, true) !== symbols.no_message_symbol) {} },
                moveMessagePortToContext: () => unavailable('Port context movement'),
                broadcastChannel: name => wrap(native('broadcast', name)),
            };
            return unavailable('Worker IO binding ' + name);
        }
        emitMessage = require('internal/per_context/messageport').emitMessage;
        io = require('internal/worker/io');
        return io;
    }
    function dispatch() {
        let count = 0;
        // A bounded per-turn visit permits the ordinary tick/job checkpoint
        // between native phases. Public port handlers never use timer keepers.
        const batch = [...registry];
        for (let i = 0; i < batch.length; i++) {
            const port = deref(batch[i]);
            if (port === undefined) { registry.delete(batch[i]); continue; }
            const before = state(port).closed;
            if (receive(port, false, true) !== symbols.no_message_symbol || !before && state(port).closed) count++;
        }
        return count;
    }
    return { MessagePort, MessageChannel, initialize, dispatch, adopt: wrap,
        drain(port) { while (receive(port, true, true) !== symbols.no_message_symbol) {} } };
}
