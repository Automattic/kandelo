// Native graph traversal owns identity, host allocation and deferred payloads.
// Cloneable host objects supply the pinned private clone/deserialize hooks;
// moving host handles and channel transport remain implementation gaps.
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
        object => {
            const result = ReflectApply(object[symbols.messaging_clone_symbol], object, []);
            // Node gets data before converting deserializeInfo to a string.
            // Keep these reads in that order, even for accessor properties.
            const data = result.data;
            const info = `${result.deserializeInfo}`;
            return [info, data];
        },
        createDeserializer,
        (object, data) => {
            const method = object[symbols.messaging_deserialize_symbol];
            if (typeof method === 'function') ReflectApply(method, object, [data]);
        });
    const module = { exports: {} };
    factories['internal/worker/js_transferable'](module, module.exports, require, primordials, internalBinding);
    return { protocol: module.exports, privateSymbols, symbols,
        setMode: platform.native.setCloneMode,
        createDeserializer,
    };
}
