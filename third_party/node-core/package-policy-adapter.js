// Shared package target/map/condition policy over actual package files and
// loader state. ESM execution, hooks and source-syntax detection are distinct.
function _createNodePackagePolicy(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayIsArray, ObjectFreeze, SafeSet, SafeMap, ObjectPrototypeHasOwnProperty,
        ReflectApply, StringPrototypeSlice } = primordials;
    const process = platform.process;
    const assert = platform.values.require('internal/assert');
    const { ERR_INVALID_ARG_VALUE, ERR_MODULE_NOT_FOUND, ERR_INVALID_ARG_TYPE } = platform.values.errors.codes;
    const getOptionValue = platform.getOptionValue;
    /* NODE_PACKAGE_POLICY_CJS_CONDITIONS */
    /* NODE_PACKAGE_POLICY_ESM_CONDITIONS */
    initializeDefaultConditions();
    /* NODE_PACKAGE_POLICY_LAZY */
    /* NODE_PACKAGE_POLICY_CWD */
    /* NODE_PACKAGE_POLICY_LEGACY_EXTENSIONS */
    const path = platform.path, url = platform.url;
    const nativeURLCanParse = url.URL.canParse;
    const nativeURLParse = url.URL.parse;
    const loaderMethods = {
        internalModuleStat: platform.stat,
        realpathSync: platform.realpath,
        legacyMainResolve(packagePath, main, base) {
            let initial = '';
            if (typeof main === 'string') {
                initial = path.resolve(packagePath, main);
                for (let i = 0; i < 7; i++)
                    if (platform.isFile(initial + legacyMainResolveExtensions[i])) return i;
            }
            for (let i = 7; i < legacyMainResolveExtensions.length; i++)
                if (platform.isFile(path.resolve(packagePath, legacyMainResolveExtensions[i]))) return i;
            if (typeof base !== 'string') throw new ERR_INVALID_ARG_TYPE('base', ['string', 'URL'], base);
            throw new ERR_MODULE_NOT_FOUND(initial || path.resolve(packagePath, './index.js'), url.fileURLToPath(base), null);
        },
        getFormatOfExtensionlessFile(filename) {
            const prefix = platform.readHeader(filename);
            return prefix !== undefined && prefix.length === 4 && prefix[0] === 0 &&
                prefix[1] === 0x61 && prefix[2] === 0x73 && prefix[3] === 0x6d ?
                /* NODE_PACKAGE_POLICY_FORMAT_WASM */ : /* NODE_PACKAGE_POLICY_FORMAT_JS */;
        },
    };
    const helpers = { loaderMethods, legacyMainResolveExtensions, legacyMainResolveExtensionsIndexes };
    const internalUtil = { ...platform.values.util, getLazy, getCWDURL };
    const factories = { /* NODE_PACKAGE_POLICY_MODULES */ };
    const modules = new SafeMap();
    function require(name) {
        if (modules.has(name)) return modules.get(name).exports;
        if (name === 'path') return path;
        if (name === 'fs') return platform.fs;
        if (name === 'internal/url') return { ...url, URLParse(input, base) {
            if (typeof nativeURLParse !== 'function')
                throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('URL.parse owner');
            return ReflectApply(nativeURLParse, url.URL, [input, base]);
        } };
        if (name === 'internal/util') return internalUtil;
        if (name === 'internal/assert') return assert;
        if (name === 'internal/options') return { getOptionValue };
        if (name === 'internal/fs/utils') return platform.fsUtils;
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/modules/helpers') return helpers;
        if (name === 'internal/modules/package_json_reader') return platform.packages;
        if (name === 'internal/modules/esm/utils') return { getConditionsSet };
        if (name === 'internal/modules/cjs/loader') return { Module: platform.getRecords().Module };
        if (name === 'internal/bootstrap/realm') return { BuiltinModule: {
            canBeRequiredWithoutScheme: name => platform.getBuiltinPolicy().canBeRequiredWithoutScheme(name),
        } };
        if (!ObjectPrototypeHasOwnProperty(factories, name))
            throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Package policy dependency: ' + name);
        const module = { exports: {} };
        modules.set(name, module);
        try {
            factories[name](module, module.exports, require, primordials, internalBinding, process);
            if (name === 'internal/modules/esm/get_format') module.exports.initializeExtensionFormatMap();
        }
        catch (error) { modules.delete(name); throw error; }
        return module.exports;
    }
    function internalBinding(name) {
        if (name === 'url') return { canParse: (...args) => ReflectApply(nativeURLCanParse, url.URL, args) };
        if (name === 'constants') return { internal: {
            EXTENSIONLESS_FORMAT_JAVASCRIPT: /* NODE_PACKAGE_POLICY_FORMAT_JS */,
            EXTENSIONLESS_FORMAT_WASM: /* NODE_PACKAGE_POLICY_FORMAT_WASM */,
        } };
        if (name === 'contextify') return { containsModuleSyntax: platform.containsModuleSyntax };
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Package policy binding: ' + name);
    }
    return { get format() { return require('internal/modules/esm/get_format'); },
        get resolver() { return require('internal/modules/esm/resolve'); },
        get maps() { return require('internal/modules/package_map'); },
        getCjsConditions, getCjsConditionsArray, getConditionsSet, getDefaultConditions, getLazy, getOptionValue };
}
