// Actual CommonJS record/graph/require owners. Private native parent fields
// are held in WeakMaps, not observable stand-in Symbols on public modules.
function _createNodeModuleRecords(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayIsArray, ArrayPrototypeFilter, ArrayPrototypeIncludes, ArrayPrototypeIndexOf, ArrayPrototypeJoin,
        ArrayPrototypePush, ArrayPrototypePushApply, ArrayPrototypeMap, ArrayPrototypeSlice, ArrayPrototypeSplice, ArrayPrototypeUnshift,
        ArrayPrototypeUnshiftApply, Boolean, ObjectCreate, ObjectDefineProperty,
        ObjectGetOwnPropertyDescriptor, ReflectApply, ReflectSet, Proxy, SafeWeakMap, SafeWeakSet, SafeSet, SafeMap,
        StringPrototypeCharAt, StringPrototypeCharCodeAt, StringPrototypeEndsWith,
        StringPrototypeIndexOf, StringPrototypeSlice, StringPrototypeSplit,
        StringPrototypeStartsWith, JSONParse, ObjectKeys, RegExpPrototypeExec, Error } = primordials;
    const path = platform.path, process = platform.process;
    const { validateString } = platform.values.validators;
    const { codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_INVALID_MODULE_SPECIFIER, ERR_UNKNOWN_BUILTIN_MODULE, ERR_UNKNOWN_MODULE_FORMAT, ERR_METHOD_NOT_IMPLEMENTED } } = platform.values.errors;
    const { setOwnProperty, getDeprecationWarningEmitter, emitExperimentalWarning } = platform.values.util;
    const { URL, pathToFileURL, fileURLToPath, isURL } = platform.url;
    const { kEmptyObject } = platform.values.util;
    const { getCjsConditions, getCjsConditionsArray, getLazy } = platform.policy;
    const { hasPackageMap, packageMapResolve } = platform.policy.maps;
    const shouldReportRequiredModules = getLazy(() => process.env.WATCH_REPORT_DEPENDENCIES);
    function require(name) {
        if (name === 'internal/modules/esm/resolve') return platform.policy.resolver;
        throw new ERR_METHOD_NOT_IMPLEMENTED('Module policy dependency: ' + name);
    }
    const isWindows = process.platform === 'win32';
    const debug = platform.debug;
    const assert = platform.values.require('internal/assert');
    const CHAR_FORWARD_SLASH = 47, CHAR_BACKWARD_SLASH = 92, CHAR_COLON = 58, CHAR_DOT = 46;
    const loaderMethods = { readFileSync: platform.read, getResolutionRoot: platform.getResolutionRoot, realpathSync: platform.realpath };
    const packageJsonReader = platform.packages;
    const _stat = filename => platform.stat(filename);
    const safeGetenv = platform.safeGetenv;
    const BuiltinModule = { normalizeRequirableId: platform.normalizeBuiltin };
    const firstParents = new SafeWeakMap(), lastParents = new SafeWeakMap();
    const urls = new SafeWeakMap(), entries = new SafeWeakSet();
    const sourcePaths = new SafeWeakMap();
    const sources = new SafeWeakMap();
    const relativeResolveCache = new SafeMap();
    const formats = new SafeWeakMap(), compiledExports = new SafeWeakMap();
    const esmPrepared = new SafeWeakMap();
    let modulePaths = [];
    let isPreloading = false, requireDepth = 0;
    const pending = platform.pendingDeprecation;
    function getOptionValue(name) {
        if (name === '--pending-deprecation') return pending;
        if (name === '--no-deprecation') return platform.noDeprecation;
        if (name === '--preserve-symlinks') return platform.preserveSymlinks === true;
        if (name === '--preserve-symlinks-main') return platform.preserveSymlinksMain === true;
        throw new primordials.Error('Unknown module deprecation option: ' + name);
    }
    function wrapModuleLoad(request, parent, isMain) {
        return Module._load(request, parent, entries.has(parent) || isMain);
    }
    function lazyModule() { return Module; }
    const hooks = _createNodeModuleHooks(platform);
    let moduleResolver;
    const { resolveHooks, loadHooks, resolveWithHooks, loadWithHooks, validateLoadStrict,
        convertCJSFilenameToURL, convertURLToCJSFilename } = hooks;
    function lazyCJSLoader() { return { resolveForCJSWithHooks }; }
    function loadBuiltinModule(name) { return { exports: platform.loadBuiltin(name) }; }
    /* NODE_CJS_HOOK_RESOLVE */
    /* NODE_CJS_HOOK_LOAD */
    /* NODE_MODULE_RECORDS */
    /* NODE_MODULE_REQUIRE */
    /* NODE_MODULE_LOOKUP */
    /* NODE_MODULE_LOAD */
    Module._cache = ObjectCreate(null);
    Module._pathCache = ObjectCreate(null);
    Module._extensions = ObjectCreate(null);
    Module.globalPaths = [];
    /* NODE_MODULE_WRAPPERS */
    /* NODE_MODULE_PACKAGES */
    /* NODE_MODULE_JSON */
    Module._extensions['.js'] = function(module, filename) {
        const initialFormat = platform.initialFormat(filename);
        const { source, format } = loadSource(module, filename, initialFormat);
        return platform.loadJavaScript(module, filename, source, format, sources.has(module));
    };
    Module._extensions['.node'] = function(module, filename) {
        return platform.loadNative(module, filename);
    };
    Module.prototype._compile = function(content, filename, format) {
        return platform.compile(this, content, filename, format);
    };
    /* NODE_MODULE_POLICY_SELF */
    /* NODE_MODULE_POLICY_RESOLVE */
    /* NODE_MODULE_POLICY_FINALIZE */
    /* NODE_MODULE_POLICY_WATCH */
    function parentFor(filename) {
        const parent = new Module(filename);
        parent.filename = filename;
        parent.paths = Module._nodeModulePaths(parent.path);
        return parent;
    }
    function make(filename, entry = false, owner) {
        const parent = owner || parentFor(filename || path.join(process.cwd(), 'repl'));
        if (entry) entries.add(parent);
        return makeRequireFunction(parent);
    }
    function create(filename, parent, isMain, sourcePath = filename) {
        const module = new Module(filename, isMain ? null : parent);
        module.filename = filename;
        module.paths = Module._nodeModulePaths(module.path);
        sourcePaths.set(module, sourcePath);
        return module;
    }
    function cached(parent, module) {
        updateChildren(parent, module, true);
        // A pending CJS record cannot stand in for native ESM status. Until
        // the engine exposes that status, fail this admission rather than
        // returning the record's initial empty exports as a namespace.
        if (!module.loaded && formats.get(module) === 'module')
            throw new ERR_METHOD_NOT_IMPLEMENTED('require(esm) pending module status');
        return module.exports;
    }
    function failed(parent, module) {
        const children = parent?.children;
        if (ArrayIsArray(children)) {
            const index = ArrayPrototypeIndexOf(children, module);
            if (index !== -1) ArrayPrototypeSplice(children, index, 1);
        }
    }
    function notFound(request, parent) {
        const requireStack = getRequireStack(parent);
        let message = `Cannot find module '${request}'`;
        if (requireStack.length) message += '\nRequire stack:\n- ' + ArrayPrototypeJoin(requireStack, '\n- ');
        const error = new primordials.Error(message);
        error.code = 'MODULE_NOT_FOUND'; error.requireStack = requireStack;
        return error;
    }
    // The ordinary guest filesystem has no experimental Node VFS mount here.
    // Activation of that VFS and its resolution roots remains a separate owner.
    Module.registerHooks = hooks.registerHooks;
    Module._initPaths();
    return { Module, make, create, cached, failed, getRequireStack, notFound,
        getModuleResolver() {
            return moduleResolver ??= _createNodeModuleSyncResolver({
                values: platform.values, policy: platform.policy, hooks,
                load: _createNodeESMLoadPlatform({ ...platform,
                    getOptionValue: platform.policy.getOptionValue }) });
        },
        resolve: (request, parent, isMain = false, options = kEmptyObject) =>
            resolveForCJSWithHooks(request, parent, isMain, options),
        loadBuiltin: loadBuiltinWithHooks,
        // Node's per-parent-directory cache belongs to the same actual record
        // transaction. A cache hit bypasses hooks; eviction reruns resolution.
        cachedResolution(parent, request) {
            const directory = parent && relativeResolveCache.get(parent.path);
            const filename = directory?.[request];
            if (filename === undefined) return undefined;
            const module = Module._cache[filename];
            if (module !== undefined) return { module };
            delete directory[request];
        },
        rememberResolution(parent, request, filename) {
            if (!parent) return;
            let directory = relativeResolveCache.get(parent.path);
            if (directory === undefined) {
                directory = ObjectCreate(null); relativeResolveCache.set(parent.path, directory);
            }
            directory[request] = filename;
        },
        forgetResolution(parent, request) {
            const directory = parent && relativeResolveCache.get(parent.path);
            if (directory !== undefined && directory !== null) delete directory[request];
        },
        prepareESM(module, resolution, source) {
            this.prepare(module, resolution, { format: resolution.format, source });
            esmPrepared.set(module, resolution);
        },
        moduleURL: module => urls.get(module),
        longestExtension: findLongestRegisteredExtension,
        pendingESM(module) { return esmPrepared.get(module); },
        takeESM(module) { const value = esmPrepared.get(module); esmPrepared.delete(module); return value; },
        loadSourceForESM(module, filename, format) { return loadSource(module, filename, format); },
        prepare(module, result, loadResult) {
            urls.set(module, result.url); formats.set(module, loadResult?.format ?? result.format);
            if (loadResult !== undefined) sources.set(module, loadResult.source);
        },
        packageMain: (directory, request) => tryPackage(directory, ObjectKeys(Module._extensions), false, request),
        originalPath: module => sourcePaths.get(module),
        setFormat: (module, format) => formats.set(module, format),
        isWrapperPatched: () => patched };
}
