// The unchanged SourceMap decoder and cache algorithms consume actual CJS
// compile metadata and Module identity. Stack/coverage activation is separate.
function _createNodeSourceMapPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { SafeMap, SafeWeakMap, Symbol, RegExpPrototypeExec, StringPrototypeStartsWith, ReflectApply } = primordials;
    const { ERR_METHOD_NOT_IMPLEMENTED } = platform.values.errors.codes;
    const path = platform.path, pathToFileURL = platform.url?.pathToFileURL;
    const URL = platform.url?.URL;
    const nativeURLParse = URL?.parse, nativeURLCanParse = URL?.canParse;
    const assert = platform.values.require('internal/assert');
    const inspect = platform.util?.inspect;
    const sourceMapData = Symbol('source_map_data');
    const sourceMapModuleData = new SafeWeakMap();
    function unavailable(name) { throw new ERR_METHOD_NOT_IMPLEMENTED('SourceMap ' + name); }
    function URLCanParse(input, base) {
        if (typeof nativeURLCanParse !== 'function') return unavailable('URL canParse owner');
        return ReflectApply(nativeURLCanParse, URL, [input, base]);
    }
    function URLParse(input, base) {
        if (typeof nativeURLParse !== 'function') return unavailable('URL parse owner');
        return ReflectApply(nativeURLParse, URL, [input, base]);
    }
    /* NODE_SOURCE_MAP_CACHE_HELPERS */
    const modules = new SafeMap();
    const factories = {
        'internal/source_map/source_map': function(module, exports, require, primordials) {
            /* NODE_PUBLIC_SOURCE_MAP */
        },
        /* NODE_SOURCE_MAP_CACHE_MODULES */
    };
    function require(name) {
        if (modules.has(name)) return modules.get(name).exports;
        if (factories[name] !== undefined) {
            const module = { exports: {} };
            modules.set(name, module);
            try { factories[name](module, module.exports, require, primordials, internalBinding, platform.process); }
            catch (error) { modules.delete(name); throw error; }
            return module.exports;
        }
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/util') return { getLazy, isUnderNodeModules, kEmptyObject: platform.values.util.kEmptyObject };
        if (name === 'internal/util/debuglog') return platform.values.require(name);
        if (name === 'internal/url') return { ...platform.url, URLParse };
        if (name === 'internal/modules/helpers') return { normalizeReferrerURL };
        if (name === 'buffer') return { Buffer: platform.Buffer };
        if (name === 'fs') return platform.fs;
        if (name === 'path') return platform.path;
        return unavailable('dependency ' + name);
    }
    function internalBinding(name) {
        if (name === 'util') return { privateSymbols: { source_map_data_private_symbol: sourceMapData } };
        // No native mapped formatter/coverage owner exists yet. Enabling a
        // flag without it would manufacture public support; do not activate.
        if (name === 'errors') return { setSourceMapsEnabled() { return unavailable('mapped stack formatter activation'); } };
        return unavailable('binding ' + name);
    }
    const api = require('internal/source_map/source_map');
    const cache = () => require('internal/source_map/source_map_cache');
    return { SourceMap: api.SourceMap,
        get findSourceMap() { return cache().findSourceMap; },
        get getSourceMapsSupport() { return cache().getSourceMapsSupport; },
        captureCommonJS(module, filename, source, info) {
            // Preserve target-disabled capture. This actual environment gate
            // admits map metadata only; it does not implement a V8 collector.
            return cache().maybeCacheSourceMap(filename, source, module, false,
                info.sourceURL, info.sourceMapURL);
        },
    };
}
