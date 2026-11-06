// Unchanged pinned public module algorithms over actual private engine records.
function _createNodeVmModules(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ObjectCreate, ObjectGetOwnPropertyDescriptor, ObjectGetPrototypeOf } = primordials;
    /* NODE_VM_GET_CONSTRUCTOR */
    const util = { ...platform.values.util, getConstructorOf };
    function call(operation, ...args) {
        return platform.native.__kandeloVmModuleOperation(operation, ...args);
    }
    const constants = call('constants');
    class ModuleWrap {
        constructor(identifier, context, sourceOrExports, lineOrSteps, columnOffset, cachedData) {
            return call('new', new.target.prototype, identifier, platform.contextGlobal(context),
                sourceOrExports, lineOrSteps, columnOffset, cachedData);
        }
        link(modules) { return call('link', this, modules); }
        instantiate() { return call('instantiate', this); }
        evaluate(timeout, breakOnSigint) { return call('evaluate', this, timeout, breakOnSigint); }
        getModuleRequests() { return call('requests', this); }
        getNamespace() { return call('namespace', this); }
        getStatus() { return call('status', this); }
        getError() { return call('error', this); }
        setExport(name, value) { return call('setExport', this, name, value); }
        createCachedData() { return call('cache', this); }
        getModuleSourceObject() { return call('moduleSource', this); }
        get hasAsyncGraph() { return call('asyncGraph', this); }
        get hasTopLevelAwait() { return call('topLevelAwait', this); }
    }
    const binding = { ...constants, ModuleWrap };
    const module = { exports: ObjectCreate(null) };
    function require(name) {
        if (name === 'internal/assert') return platform.assert;
        if (name === 'internal/util/types') return platform.types;
        if (name === 'internal/util') return util;
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/vm') return { isContext: platform.isContext };
        if (name === 'internal/util/inspect') return platform.inspection;
        if (name === 'internal/modules/esm/utils') return {
            registerModule(wrap, registry) { return call('register', wrap, registry); },
        };
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('VM module dependency ' + name);
    }
    (function(module, exports, require, primordials, internalBinding) {
        /* NODE_VM_MODULE_CLASSES */
    })(module, module.exports, require, primordials, name => {
        if (name === 'module_wrap') return binding;
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('VM module binding ' + name);
    });
    return module.exports;
}
