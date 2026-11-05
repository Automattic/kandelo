// Keep weak registrations and refable dispatch in the pinned Node algorithms.
// Their process is the guest EventEmitter; no host exit/GC owner is substituted.
function _installNodeProcessLifetime(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { FunctionPrototypeCall, ObjectDefineProperty, SymbolFor } = primordials;
    const process = platform.process;
    const perThreadSetup = (() => {
        /* NODE_PROCESS_LIFETIME_REFS */
        return { ref, unref };
    })();
    let finalizationModule;
    function require(name) {
        if (name === 'internal/validators') return platform.values.validators;
        if (name !== 'internal/process/finalization') {
            throw new primordials.Error('Unexpected process lifetime dependency: ' + name);
        }
        if (finalizationModule === undefined) {
            const module = { exports: {} };
            (function(module, exports, require) {
                /* NODE_PROCESS_FINALIZATION */
            })(module, module.exports, require);
            finalizationModule = module.exports;
        }
        return finalizationModule;
    }
    /* NODE_PROCESS_LIFETIME_BOOTSTRAP */
}
