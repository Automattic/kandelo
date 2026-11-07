// Native graph traversal owns identity, host allocation and deferred payloads.
// Registered JS hosts supply pinned clone/transfer/list/deserialize hooks.
// Native writer/packet owners handle admission, graph identity and moves;
// per-type native ownership and malformed/outcome parity remain separate gaps.
function _createNodeClonePlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { Symbol, Error, ReflectApply } = primordials;
    const privateSymbols = { transfer_mode_private_symbol: platform.native.createCloneModeSymbol() };
    const symbols = {
        messaging_clone_symbol: Symbol('messaging_clone_symbol'),
        messaging_deserialize_symbol: Symbol('messaging_deserialize_symbol'),
        messaging_transfer_symbol: Symbol('messaging_transfer_symbol'),
        messaging_transfer_list_symbol: Symbol('messaging_transfer_list_symbol'),
    };
    let deserializerFactory;
    const factories = {
        /* NODE_CLONE_MODULES */
    };
    function unavailable(name) {
        const error = new Error('Node clone protocol dependency is not implemented: ' + name);
        error.code = 'ERR_NOT_IMPLEMENTED'; throw error;
    }
    function require(name) {
        if (name === 'internal/errors') return platform.values.errors;
        // Bootstrap loads event interfaces before installing the Web IDL
        // module. The protocol accesses this converter only at clone time.
        if (name === 'internal/webidl') return {
            get converters() { return platform.getWebIDL().converters; },
        };
        return platform.getModule(name);
    }
    function internalBinding(name) {
        if (name === 'symbols') return symbols;
        if (name === 'util') return { privateSymbols, setCloneMode: platform.native.setCloneMode, constants: /* NODE_CLONE_CONSTANTS */ };
        if (name === 'messaging') return {
            structuredClone: (value, options) => platform.native.cloneValue(value, options.transfer),
            setDeserializerCreateObjectFunction(fn) { deserializerFactory = fn; },
        };
        return unavailable(name);
    }
    function createDeserializer(info) {
        if (!deserializerFactory) return unavailable('host-object deserializer');
        return deserializerFactory(info);
    }
    platform.native.configureClone(privateSymbols.transfer_mode_private_symbol,
        message => new (platform.getDOMException())(message, 'DataCloneError'),
        (object, transfer = false) => {
            const method = transfer ? symbols.messaging_transfer_symbol : symbols.messaging_clone_symbol;
            const callback = object[method];
            if (typeof callback !== 'function') return undefined;
            const result = ReflectApply(callback, object, []);
            if (result === null || (typeof result !== 'object' && typeof result !== 'function')) return undefined;
            // Read data then info here; native write owns UTF-8 conversion and
            // the resulting packet/drop/deferred-error transaction.
            const data = result.data;
            return [result.deserializeInfo, data];
        },
        createDeserializer,
        (object, data) => {
            const method = object[symbols.messaging_deserialize_symbol];
            if (typeof method === 'function') ReflectApply(method, object, [data]);
        },
        object => {
            const method = object[symbols.messaging_transfer_list_symbol];
            return typeof method === 'function' ? ReflectApply(method, object, []) : undefined;
        });
    const module = { exports: {} };
    factories['internal/worker/js_transferable'](module, module.exports, require, primordials, internalBinding);
    return { protocol: module.exports, privateSymbols, symbols,
        setMode: platform.native.setCloneMode,
        createDeserializer,
    };
}
