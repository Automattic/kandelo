// Shared private dependencies for pinned Node errors and validators. Missing
// engine stack recapture remains explicit in build.py's diagnostic guards;
// no synthetic stack or successful unsupported native binding is supplied.
function _createNodeValuesPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { Error, ObjectCreate, ObjectDefineProperty, ObjectFreeze,
        ObjectPrototypeHasOwnProperty, SafeMap, Symbol } = primordials;
    const process = platform.process;
    const modules = new SafeMap();
    const factories = {
        /* NODE_VALUES_MODULES */
    };
    const kEmptyObject = ObjectFreeze(ObjectCreate(null));
    const kEnumerableProperty = ObjectFreeze({ __proto__: null, enumerable: true });
    const privateSymbols = { arrow_message_private_symbol: Symbol('arrow_message') };
    function unavailable(name) {
        const error = new Error('Node compatibility binding is not implemented: ' + name);
        error.code = 'ERR_NOT_IMPLEMENTED'; throw error;
    }
    const loading = new SafeMap();
    function require(name) {
        if (loading.has(name)) return loading.get(name).exports;
        if (modules.has(name)) return modules.get(name);
        if (name === 'internal/process/warning') {
            if (typeof platform.getWarnings !== 'function') return unavailable(name);
            return platform.getWarnings();
        }
        if (name === 'internal/util') {
            const helpers = require('internal/util/core_helpers');
            const result = {
                ...helpers, kEmptyObject, kEnumerableProperty,
                isWindows: process.platform === 'win32', isMacOS: process.platform === 'darwin',
                SideEffectFreeRegExpPrototypeSymbolReplace(regex, text, replacement) {
                    const flags = ObjectCreate(null);
                    const entries = [
                        ['hasIndices', 'HasIndices', 'd'], ['global', 'Global', 'g'],
                        ['ignoreCase', 'IgnoreCase', 'i'], ['multiline', 'Multiline', 'm'],
                        ['dotAll', 'DotAll', 's'], ['unicode', 'Unicode', 'u'],
                        ['unicodeSets', 'UnicodeSets', 'v'], ['sticky', 'Sticky', 'y'],
                    ];
                    let names = '';
                    for (let i = 0; i < entries.length; i++) {
                        const entry = entries[i];
                        const getter = primordials['RegExpPrototypeGet' + entry[1]];
                        const enabled = getter === undefined ? false : getter(regex);
                        if (enabled) names += entry[2];
                        flags[entry[0]] = enabled;
                    }
                    const copy = new primordials.RegExp(primordials.RegExpPrototypeGetSource(regex), names);
                    copy.lastIndex = regex.lastIndex;
                    // RegExp's replace algorithm consults these properties.
                    // Keep those reads on this owned copy independent of
                    // user changes to RegExp.prototype.
                    const observed = ['global', 'unicode', 'unicodeSets'];
                    for (let i = 0; i < observed.length; i++) {
                        const name = observed[i];
                        ObjectDefineProperty(copy, name, { value: flags[name] });
                    }
                    ObjectDefineProperty(copy, 'exec', {
                        value: text => primordials.RegExpPrototypeExec(copy, text),
                    });
                    return primordials.RegExpPrototypeSymbolReplace(copy, text, replacement);
                },
                getSystemErrorName: platform.uv?.getSystemErrorName || platform.util.getSystemErrorName,
                getSystemErrorMessage: platform.uv?.getSystemErrorMessage ||
                    platform.util.getSystemErrorMessage || (() => unavailable('uv.getErrorMessage')),
                getSystemErrorMap: platform.uv?.getSystemErrorMap ||
                    platform.util.getSystemErrorMap || (() => unavailable('uv.getErrorMap')),
                customInspectSymbol: primordials.SymbolFor('nodejs.util.inspect.custom'),
                setOwnProperty(object, key, value) {
                    ObjectDefineProperty(object, key, { __proto__: null, value,
                        writable: true, enumerable: true, configurable: true });
                    return value;
                },
                lazyDOMException(message, name) {
                    return new (platform.getDOMException())(message, name);
                },
            };
            modules.set(name, result);
            return result;
        }
        if (!ObjectPrototypeHasOwnProperty(factories, name)) return unavailable(name);
        const module = { exports: {} };
        loading.set(name, module);
        modules.set(name, module.exports);
        try { factories[name](module, module.exports, require, primordials, internalBinding, process); }
        catch (error) { modules.delete(name); loading.delete(name); throw error; }
        modules.set(name, module.exports);
        loading.delete(name);
        return module.exports;
    }
    function internalBinding(name) {
        if (name === 'constants') return { os: { signals: platform.signals } };
        if (name === 'util') return { privateSymbols };
        if (name === 'uv') return platform.uv?.binding ||
            { getErrorMap() { return unavailable('uv.getErrorMap'); } };
        return unavailable(name);
    }
    modules.set('buffer', { Buffer: platform.Buffer });
    modules.set('util', platform.util);
    modules.set('os', platform.os);
    modules.set('internal/util/inspect', platform.inspection);
    modules.set('internal/util/types', platform.util.types);
    // This is actual embedding state: no V8 startup snapshot is being built.
    // It does not advertise V8 snapshot serialization or loading support.
    modules.set('internal/v8/startup_snapshot', {
        namespace: { isBuildingSnapshot: () => false },
    });
    return { errors: require('internal/errors'),
        validators: require('internal/validators'),
        util: require('internal/util'), require };
}
