// Public algorithms are pinned unchanged. Native state owns address bytes,
// rule synchronization and lifetime; cloning that state remains a separate
// serializer/worker prerequisite, not a JSON copy of a live rule set.
function _createNodeAddressRules(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ObjectGetOwnPropertyDescriptors, ObjectPrototypeHasOwnProperty,
        SafeMap, Symbol, SymbolFor, Error, TypeError } = primordials;
    const { codes } = platform.values.errors;
    const factories = { /* NODE_ADDRESS_RULE_MODULES */ };
    const modules = new SafeMap();
    function invoke(operation, ...args) {
        const result = platform.native.addressRules(operation, ...args);
        if (result.error) {
            if (result.error === 'ERR_INVALID_ADDRESS') {
                const error = new Error('Invalid socket address');
                error.code = 'ERR_INVALID_ADDRESS'; throw error;
            }
            if (result.error === 'ERR_INVALID_THIS') throw new codes.ERR_INVALID_THIS('SocketAddress or BlockList');
            if (result.error === 'ERR_OUT_OF_RANGE') throw new codes.ERR_OUT_OF_RANGE('prefix', '>= 0 && <= ' + result.value, args[2]);
            throw new TypeError(result.error);
        }
        return result.value;
    }
    const [AF_INET, AF_INET6] = invoke('families');
    class SocketAddressHandle {
        constructor(address, port, family, flowlabel) {
            const owner = invoke('createAddress', new.target.prototype, address, port, family, flowlabel);
            // A property-only clone would lose the actual native address.
            // Reject until messaging retains/deserializes this shared owner.
            platform.clone.protocol.markTransferMode(owner, false, false);
            return owner;
        }
        detail(output) {
            const fields = invoke('detail', this);
            output.address = fields[0]; output.port = fields[1];
            output.family = fields[2]; output.flowlabel = fields[3];
            return output;
        }
        flowlabel() { return invoke('flowlabel', this); }
    }
    class BlockListHandle {
        constructor() {
            const owner = invoke('createList', new.target.prototype);
            platform.clone.protocol.markTransferMode(owner, false, false);
            return owner;
        }
        addAddress(address) { return invoke('addAddress', this, address); }
        addAddresses(addresses) { return invoke('addAddresses', this, addresses); }
        addRange(start, end) { return invoke('addRange', this, start, end); }
        addSubnet(network, prefix) { return invoke('addSubnet', this, network, prefix); }
        removeAddress(address) { return invoke('removeAddress', this, address); }
        removeRange(start, end) { return invoke('removeRange', this, start, end); }
        removeSubnet(network, prefix) { return invoke('removeSubnet', this, network, prefix); }
        check(address) { return invoke('check', this, address); }
        checkString(address, family) { return invoke('checkString', this, address, family); }
        getRules() { return invoke('rules', this); }
        getSize() { return invoke('size', this); }
        clear() { return invoke('clear', this); }
    }
    const binding = { SocketAddress: SocketAddressHandle, BlockList: BlockListHandle, AF_INET, AF_INET6 };
    const symbols = { owner_symbol: Symbol('owner') };
    const URLParse = platform.URLParse;
    function require(name) {
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/util') return { ...platform.values.util,
            kEmptyObject: platform.values.require('internal/util').kEmptyObject,
            customInspectSymbol: SymbolFor('nodejs.util.inspect.custom') };
        if (name === 'internal/util/inspect') return platform.inspection;
        if (name === 'internal/worker/js_transferable') return platform.clone.protocol;
        if (name === 'internal/url') return { URLParse };
        if (modules.has(name)) return modules.get(name).exports;
        if (!ObjectPrototypeHasOwnProperty(factories, name)) throw new codes.ERR_NOT_IMPLEMENTED('address rules dependency ' + name);
        const module = { exports: {} }; modules.set(name, module);
        try { factories[name](module, module.exports, require, primordials, internalBinding); }
        catch (error) { modules.delete(name); throw error; }
        return module.exports;
    }
    function internalBinding(name) {
        if (name === 'block_list') return binding;
        if (name === 'symbols') return symbols;
        throw new codes.ERR_NOT_IMPLEMENTED('address rules binding ' + name);
    }
    let BlockList, SocketAddress;
    const netExports = { /* NODE_ADDRESS_NET_GETTERS */ };
    return { require, netDescriptors: ObjectGetOwnPropertyDescriptors(netExports) };
}
