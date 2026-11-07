// Real URL/type/source transactions consumed by the native module registry.
// Source text, native synthetic exports and CJS records keep their own owners.
function _createNodeESMGraphPlatform(platform) {
    'use strict';
    const P = _createNodePrimordials();
    const { SafeMap, SafeSet, SafeWeakMap, ArrayPrototypePush, ArrayPrototypeIncludes, ObjectKeys,
        ObjectPrototypeHasOwnProperty, JSONStringify, StringPrototypeStartsWith,
        StringPrototypeIncludes, StringPrototypeSlice } = P;
    const { validateString } = platform.values.validators;
    const { ERR_INVALID_STATE, ERR_UNKNOWN_BUILTIN_MODULE, ERR_UNKNOWN_MODULE_FORMAT,
        ERR_METHOD_NOT_IMPLEMENTED, ERR_INVALID_RETURN_PROPERTY_VALUE } = platform.values.errors.codes;
    const { Module } = platform.records;
    const resolutions = new SafeMap(), sources = new SafeMap();
    const cjsNames = new SafeWeakMap();
    const empty = platform.values.util.kEmptyObject;
    const { URL, pathToFileURL, fileURLToPath } = platform.url;
    const URLParse = P.FunctionPrototypeBind(URL.parse, URL);
    function canonical(value) {
        validateString(value, 'url');
        // Paths enter from CJS require(esm)/file mains; resolved imports already
        // have genuine absolute URLs. Never use a filesystem path as URL identity.
        const parsed = URLParse(value);
        return parsed === null ? pathToFileURL(value).href : value;
    }
    function key(url, attributes = empty) {
        const type = attributes.type === undefined ? 'javascript' : attributes.type;
        validateString(type, 'type');
        return JSONStringify([url, type]);
    }
    function resolve(specifier, parent, attributes = empty, resolveOnly = false) {
        const parentURL = typeof parent === 'string' && parent.length > 0 ? canonical(parent) : undefined;
        const result = platform.records.getModuleResolver().resolveSync(parentURL,
            { __proto__: null, specifier, attributes });
        if (resolveOnly) return result.url;
        resolutions.set(key(result.url, attributes), { __proto__: null,
            result, parentURL, attributes: result.importAttributes ?? attributes });
        return result.url;
    }
    function record(identifier, attributes = empty) {
        const url = canonical(identifier);
        const resolutionKey = key(url, attributes);
        const resolution = resolutions.get(resolutionKey);
        resolutions.delete(resolutionKey);
        const actualAttributes = resolution?.attributes ?? attributes;
        return { __proto__: null, url, key: key(url, actualAttributes),
            resolution: resolution?.result ?? { __proto__: null, url },
            format: resolution?.result.format, importAttributes: actualAttributes,
            parentURL: resolution?.parentURL };
    }
    function stringify(source) {
        if (typeof source === 'string') return source;
        if (!platform.types.isArrayBufferView(source) && !platform.types.isAnyArrayBuffer(source))
            throw new ERR_INVALID_RETURN_PROPERTY_VALUE('string, array buffer, or typed array', 'load', 'source', source);
        return new platform.TextDecoder().decode(source);
    }
    function filename(url) {
        if (!StringPrototypeStartsWith(url, 'file://')) return url;
        const parsed = new URL(url);
        try { return fileURLToPath(parsed); } catch { return parsed.pathname; }
    }
    function emplaceCJS(file) {
        let module = Module._cache[file];
        if (module !== undefined) return module;
        module = platform.records.create(file, undefined, false);
        Module._cache[file] = module;
        return module;
    }
    // Same cache-before-recursion and export/reexport policy as pinned
    // cjsPreparseModuleExports. Private per-record fields use WeakMaps.
    function preparseCJS(file, source, format, url) {
        const module = emplaceCJS(file);
        let names = cjsNames.get(module);
        if (names !== undefined) return { module, names };
        if (source === undefined)
            ({ source, format } = platform.records.loadSourceForESM(module, file, format));
        source = stringify(source);
        const parsed = platform.native.moduleSyntax('cjs-exports', source, url || file);
        names = new SafeSet();
        for (let i = 0; i < parsed[0].length; i++) names.add(parsed[0][i]);
        cjsNames.set(module, names);
        platform.records.prepareESM(module, { __proto__: null,
            filename: file, url: url || pathToFileURL(file).href, format }, source);
        for (let i = 0; i < parsed[1].length; i++) {
            const reexport = parsed[1][i];
            let target;
            try { target = platform.records.resolve(reexport, module); } catch { continue; }
            if (target.format === 'commonjs' ||
                (!platform.normalizeBuiltin(target.filename) && platform.records.longestExtension(target.filename) === '.js')) {
                const nested = preparseCJS(target.filename, undefined, target.format, target.url);
                for (const name of nested.names) names.add(name);
            }
        }
        return { module, names };
    }
    function valuesFor(names, read) {
        const result = [];
        for (let i = 0; i < names.length; i++)
            P.ObjectDefineProperty(result, i, { __proto__: null, value: read(names[i]),
                enumerable: true, writable: true, configurable: true });
        return result;
    }
    function synthetic(names, evaluate) {
        return { __proto__: null, format: 'synthetic', exportNames: names, evaluate };
    }
    function translate(rec, loaded) {
        const { url, parentURL } = rec;
        platform.records.getModuleResolver().validateLoadResult(url, loaded.format);
        switch (loaded.translatorKey ?? loaded.format) {
            case 'module':
                return { __proto__: null, format: 'module', source: stringify(loaded.source) };
            case 'builtin': {
                const id = StringPrototypeSlice(url, 5);
                const normalized = platform.normalizeBuiltin('node:' + id);
                if (!StringPrototypeStartsWith(url, 'node:') || normalized === undefined)
                    throw new ERR_UNKNOWN_BUILTIN_MODULE(url);
                const exports = platform.loadBuiltin(normalized);
                const names = ObjectKeys(exports);
                if (!ArrayPrototypeIncludes(names, 'default')) ArrayPrototypePush(names, 'default');
                return synthetic(names, () => valuesFor(names, name => name === 'default' ? exports : exports[name]));
            }
            case 'commonjs': case 'commonjs-sync': case 'require-commonjs': {
                const file = filename(url), source = stringify(loaded.source);
                const { module, names: discovered } = preparseCJS(file, source, loaded.format, url);
                const names = [...discovered];
                if (!discovered.has('default')) ArrayPrototypePush(names, 'default');
                if (!discovered.has('module.exports')) ArrayPrototypePush(names, 'module.exports');
                return synthetic(names, () => {
                    if (!module.loaded) {
                        const exports = Module._load(file, undefined, parentURL === undefined);
                        // Actual Module._load monkey-patchers may return without
                        // populating the ESM-created record, as in pinned Node.
                        if (!module.loaded) { module.exports = exports; module.loaded = true; platform.records.takeESM(module); }
                    }
                    const exports = module.exports;
                    return valuesFor(names, name => {
                        if (name === 'default' || name === 'module.exports') return exports;
                        if (!ObjectPrototypeHasOwnProperty(exports, name)) return undefined;
                        try { return exports[name]; } catch { return undefined; }
                    });
                });
            }
            case 'json': {
                const parsed = new URL(url);
                const pathname = StringPrototypeStartsWith(url, 'file:') ? fileURLToPath(parsed) : undefined;
                const file = pathname && !StringPrototypeIncludes(url, '?') && !StringPrototypeIncludes(url, '#') ? pathname : undefined;
                let module = file === undefined ? undefined : Module._cache[file];
                if (!module?.loaded) {
                    const errorPath = parsed.protocol === 'file:' ? fileURLToPath(parsed) : url;
                    const exports = platform.parseJSON(stringify(loaded.source), errorPath);
                    module = { exports, loaded: true };
                    if (file !== undefined) Module._cache[file] = module;
                }
                return synthetic(['default'], () => [module.exports]);
            }
            case 'wasm': case 'addon': case 'module-typescript': case 'commonjs-typescript':
                throw new ERR_METHOD_NOT_IMPLEMENTED('ES module translator ' + loaded.format);
            default:
                throw new ERR_UNKNOWN_MODULE_FORMAT(loaded.format, url);
        }
    }
    function load(rec) {
        let slot = sources.get(rec.key);
        if (slot !== undefined) {
            if (slot.state === 0) throw new ERR_INVALID_STATE('Module source load is already in progress: ' + rec.url);
            return slot.value;
        }
        slot = { __proto__: null, state: 0, value: undefined };
        sources.set(rec.key, slot);
        try {
            const loaded = platform.records.getModuleResolver().load(rec.url,
                { __proto__: null, format: rec.format, importAttributes: rec.importAttributes });
            const context = { ...rec.resolution, ...loaded,
                translatorKey: loaded.format, __proto__: null };
            slot.value = translate(rec, context); slot.state = 1;
            return slot.value;
        } catch (error) {
            // Node creates its synchronous ModuleJob only after load/translation
            // succeeds. A thrown load/parse attempt is retried, not a cached job.
            sources.delete(rec.key); throw error;
        }
    }
    function failed(rec) {
        // Native source compilation failed before registry publication. Retire
        // that source transaction; retain the caller's actual exception.
        sources.delete(rec.key);
    }
    function prepare(identifier, loaded) {
        const rec = record(identifier);
        if (sources.has(rec.key)) return;
        const slot = { __proto__: null, state: 0, value: undefined };
        sources.set(rec.key, slot);
        try { slot.value = translate(rec, loaded); slot.state = 1; }
        catch (error) { sources.delete(rec.key); throw error; }
    }
    return { canonical, resolve, record, load, failed, prepare };
}
