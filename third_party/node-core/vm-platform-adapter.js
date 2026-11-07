// Pinned public validation/dispatch over actual realm and compiled-code owners.
// Realm globals and Stencils remain private; public context identity is the
// supplied sandbox. This does not implement the missing exotic property hooks.
function _createNodeVmPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { SafeWeakMap, Symbol, ObjectCreate } = primordials;
    const native = platform.native;
    const contexts = new SafeWeakMap();
    const scripts = new SafeWeakMap();
    const codeOptions = new SafeWeakMap();
    const { ERR_INVALID_THIS } = platform.values.errors.codes;
    function unavailable(feature) {
        const error = new primordials.Error('Node VM feature is not implemented: ' + feature);
        error.code = 'ERR_NOT_IMPLEMENTED'; throw error;
    }
    const symbols = {
        vm_dynamic_import_main_context_default: Symbol('vm_dynamic_import_main_context_default'),
        vm_context_no_contextify: Symbol('vm_context_no_contextify'),
    };
    const { vm_dynamic_import_main_context_default } = symbols;
    const vm_dynamic_import_default_internal = Symbol('vm_dynamic_import_default_internal');
    const vm_dynamic_import_no_callback = Symbol('vm_dynamic_import_no_callback');
    const vm_dynamic_import_missing_flag = Symbol('vm_dynamic_import_missing_flag');
    const { validateFunction } = platform.values.validators;
    const getOptionValue = platform.getOptionValue;
    /* NODE_VM_IMPORT_OPTION_ID */
    let vmModules;
    function getVmModules() {
        return vmModules ??= _createNodeVmModules({ native, values: platform.values,
            types: platform.types, inspection: platform.inspection, assert: platform.assert,
            contextGlobal, isContext: object => contexts.has(object) });
    }
    const { ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING,
        ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG } = platform.values.errors.codes;
    async function missingImportCallback() { throw new ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING(); }
    async function missingImportFlag() { throw new ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG(); }
    async function defaultImportUnavailable() {
        return unavailable('VM main-context-default-loader referrer/warning ownership');
    }
    function setImportRegistry(referrer, callback, retainReferrer) {
        native.__kandeloVmRegisterImport(scripts.get(referrer) ?? referrer, {
            __proto__: null,
            importModuleDynamically: callback,
            callbackReferrer: retainReferrer ? referrer : undefined,
        });
    }
    function registerImportModuleDynamically(referrer, callback) {
        if (callback === undefined) return;
        if (!codeOptions.has(referrer)) unavailable('context-scope eval dynamic-import ownership');
        const optionId = codeOptions.get(referrer);
        if (callback === vm_dynamic_import_main_context_default ||
            callback === vm_dynamic_import_default_internal) {
            setImportRegistry(referrer, defaultImportUnavailable, false);
        } else if (optionId === vm_dynamic_import_missing_flag) {
            // getHostDefinedOptionId owns this decision. An internal caller
            // such as REPL can supply its own real option id without the flag.
            setImportRegistry(referrer, missingImportFlag, false);
        } else {
            const { importModuleDynamicallyWrap } = getVmModules();
            setImportRegistry(referrer, importModuleDynamicallyWrap(callback), true);
        }
    }
    /* NODE_VM_MAKE_CONTEXTIFY_SCRIPT */
    function compileOptions(filename, lineOffset, columnOffset, cachedData, produceCachedData) {
        if (cachedData !== undefined || produceCachedData) unavailable('persistent script/function cache');
        if (lineOffset < 0 || columnOffset < 0) unavailable('negative source offsets');
        return { filename, lineOffset, columnOffset };
    }
    function contextGlobal(context) {
        if (context === undefined || context === null) return platform.global;
        const global = contexts.get(context);
        if (global === undefined) throw new ERR_INVALID_THIS('Context');
        return global;
    }
    function internalCompileFunction(code, filename, lineOffset, columnOffset, cachedData,
        produceCachedData, parsingContext, contextExtensions, params, _optionId, callback) {
        const options = compileOptions(filename, lineOffset, columnOffset, cachedData, produceCachedData);
        // The native compiler receives body/parameters separately and retains
        // the actual context extensions, rather than evaluating a function
        // expression whose caller-controlled parameters can escape its body.
        const fn = native.__kandeloVmCompileFunction(code, params ?? [],
            contextGlobal(parsingContext), options, contextExtensions);
        codeOptions.set(fn, _optionId);
        setImportRegistry(fn, missingImportCallback, false);
        registerImportModuleDynamically(fn, callback);
        return { function: fn };
    }
    class ContextifyScript {
        constructor(code, filename, lineOffset, columnOffset, cachedData, produceCachedData,
            _parsingContext, optionId) {
            const options = compileOptions(filename, lineOffset, columnOffset, cachedData, produceCachedData);
            scripts.set(this, native.__kandeloVmCompile(code, options));
            codeOptions.set(this, optionId);
            setImportRegistry(this, missingImportCallback, false);
        }
        runInContext(context, timeout, displayErrors, breakOnSigint, breakFirstLine) {
            const script = scripts.get(this);
            if (script === undefined) throw new ERR_INVALID_THIS('Script');
            if (breakOnSigint || breakFirstLine) unavailable('owned execution interrupt/debugger');
            return native.__kandeloVmRunInContext(script, contextGlobal(context),
                { displayErrors, timeout: timeout === -1 ? undefined : timeout });
        }
        createCachedData() { return unavailable('persistent script cache'); }
    }
    function makeContext(sandbox, name, origin, strings, wasm, microtaskQueue) {
        if (microtaskQueue) unavailable('per-context microtask queue');
        const noContextify = sandbox === symbols.vm_context_no_contextify;
        const global = native.__kandeloVmMakeContext(noContextify ? null : sandbox,
            { name, origin, strings, wasm, noContextify });
        const context = noContextify ? global : sandbox;
        contexts.set(context, global);
        return context;
    }
    const contextify = { ContextifyScript, makeContext,
        measureMemory() { return unavailable('real context memory measurement'); },
        // Private dispatch tokens only; these do not describe measured memory
        // or claim that SpiderMonkey implements V8's measurement enums.
        constants: { measureMemory: { mode: { SUMMARY: Symbol('summary'), DETAILED: Symbol('detailed') },
            execution: { DEFAULT: Symbol('default'), EAGER: Symbol('eager') } } },
    };
    const util = { ...platform.values.util, kVmBreakFirstLineSymbol: Symbol('kVmBreakFirstLine') };
    const internalVm = { getHostDefinedOptionId, registerImportModuleDynamically,
        internalCompileFunction, makeContextifyScript, isContext: object => contexts.has(object) };
    function require(name) {
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/util') return util;
        if (name === 'internal/vm') return internalVm;
        return unavailable(name);
    }
    function internalBinding(name) {
        if (name === 'contextify') return contextify;
        if (name === 'symbols') return symbols;
        return unavailable('binding ' + name);
    }
    const module = { exports: ObjectCreate(null) };
    const process = platform.process;
    (function(module, exports, require, primordials, internalBinding, process) {
        /* NODE_PUBLIC_VM */
    })(module, module.exports, require, primordials, internalBinding, process);
    if (getOptionValue('--experimental-vm-modules')) {
        const modules = getVmModules();
        module.exports.Module = modules.Module;
        module.exports.SourceTextModule = modules.SourceTextModule;
        module.exports.SyntheticModule = modules.SyntheticModule;
    }
    if (platform.installInternal) platform.installInternal(internalVm);
    return module.exports;
}
