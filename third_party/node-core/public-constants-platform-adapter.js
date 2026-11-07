// Shared real native constant bags, and lazy public-module initialization.
// Eager internal crypto API consumers retain their existing actual object.
function _createNodePublicConstantModules(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayPrototypePush, ObjectDefineProperties, ObjectDefineProperty,
        SafeMap, StringPrototypeStartsWith } = primordials;
    const process = platform.process;
    const moduleLoadList = process.moduleLoadList;
    const binding = platform.binding;
    const requireBuiltin = platform.require;
    const requireWithFallbackInDeps = requireBuiltin;
    function internalBinding(name) {
        if (name === 'constants') return binding;
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Legacy constants binding ' + name);
    }
    function getOptionValue(name) {
        if (name === '--tls-cipher-list' && typeof platform.cliOptions.tlsCipherList === 'string')
            return platform.cliOptions.tlsCipherList;
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Actual crypto CLI option owner ' + name);
    }
    const source = /* NODE_LEGACY_CONSTANTS_SOURCE */;
    function compileFunction(id) {
        if (id === 'constants')
            return platform.compileSource('(function(exports, require, module, process, internalBinding, primordials) {' + source + '\n})', 'node:constants');
        return function(exports, require, module) {
            const constants = binding.crypto;
            /* NODE_CRYPTO_DEFAULT_CIPHER */
            ObjectDefineProperties(module.exports, {
                /* NODE_CRYPTO_CONSTANTS_PROPERTY */
            });
        };
    }
    class ConstantModule {
        constructor(id, exports) {
            this.id = id;
            this.exports = exports;
            this.loaded = false;
            this.loading = false;
        }
        /* NODE_CONSTANTS_COMPILE */
    }
    const records = new SafeMap([
        ['constants', new ConstantModule('constants', {})],
        ['crypto', new ConstantModule('crypto', platform.crypto)],
    ]);
    return { load(id) { return records.get(id).compileForInternalLoader(); } };
}
