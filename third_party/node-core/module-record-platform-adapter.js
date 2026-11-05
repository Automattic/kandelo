// Actual CommonJS record/graph/require owners. Private native parent fields
// are held in WeakMaps, not observable stand-in Symbols on public modules.
function _createNodeModuleRecords(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayIsArray, ArrayPrototypeFilter, ArrayPrototypeIncludes, ArrayPrototypeIndexOf, ArrayPrototypeJoin,
        ArrayPrototypePush, ArrayPrototypePushApply, ArrayPrototypeMap, ArrayPrototypeSlice, ArrayPrototypeSplice, ArrayPrototypeUnshift,
        ArrayPrototypeUnshiftApply, Boolean, ObjectCreate, ObjectDefineProperty,
        ObjectGetOwnPropertyDescriptor, ReflectApply, SafeWeakMap, SafeWeakSet,
        StringPrototypeCharAt, StringPrototypeCharCodeAt, StringPrototypeEndsWith,
        StringPrototypeIndexOf, StringPrototypeSlice, StringPrototypeSplit,
        StringPrototypeStartsWith, JSONParse, ObjectKeys, RegExpPrototypeExec, Error } = primordials;
    const path = platform.path, process = platform.process;
    const { validateString } = platform.values.validators;
    const { codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_INVALID_MODULE_SPECIFIER, ERR_METHOD_NOT_IMPLEMENTED } } = platform.values.errors;
    const { setOwnProperty, getDeprecationWarningEmitter, emitExperimentalWarning } = platform.values.util;
    const { URL, pathToFileURL, fileURLToPath, isURL } = platform.url;
    const { kEmptyObject } = platform.values.util;
    const { getCjsConditions, getLazy } = platform.policy;
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
    const loaderMethods = { getResolutionRoot: platform.getResolutionRoot, realpathSync: platform.realpath };
    const packageJsonReader = platform.packages;
    const _stat = filename => platform.stat(filename);
    const safeGetenv = platform.safeGetenv;
    const BuiltinModule = { normalizeRequirableId: platform.normalizeBuiltin };
    const firstParents = new SafeWeakMap(), lastParents = new SafeWeakMap();
    const urls = new SafeWeakMap(), entries = new SafeWeakSet();
    const sourcePaths = new SafeWeakMap();
    const formats = new SafeWeakMap(), compiledExports = new SafeWeakMap();
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
    function lazyCJSLoader() {
        return { resolveForCJSWithHooks(request, parent, isMain, options) {
            // Resolution hooks have no owner yet; this path is the ordinary
            // current resolver, with real lookup options passed through.
            return platform.resolve(request, parent, options.requireResolveOptions);
        } };
    }
    /* NODE_MODULE_RECORDS */
    /* NODE_MODULE_REQUIRE */
    /* NODE_MODULE_LOOKUP */
    /* NODE_MODULE_LOAD */
    Module._cache = ObjectCreate(null);
    Module._pathCache = ObjectCreate(null);
    Module._extensions = ObjectCreate(null);
    Module.globalPaths = [];
    /* NODE_MODULE_PACKAGES */
    function loadSource(module, filename) { return { source: platform.read(filename) }; }
    /* NODE_MODULE_JSON */
    Module._extensions['.js'] = function(module, filename) {
        const content = platform.read(filename);
        return platform.loadJavaScript(module, filename, content);
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
    Module._initPaths();
    return { Module, make, create, cached, failed, getRequireStack, notFound,
        packageMain: (directory, request) => tryPackage(directory, ObjectKeys(Module._extensions), false, request),
        originalPath: module => sourcePaths.get(module),
        setFormat: (module, format) => formats.set(module, format) };
}
