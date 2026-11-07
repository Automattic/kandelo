// A lazy real builtin record retains its actual exports during reentry and
// retries failed initialization; the pinned sys source owns its warning call.
function _createNodeSysPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayPrototypePush, StringPrototypeStartsWith } = primordials;
    const process = platform.process;
    const moduleLoadList = process.moduleLoadList;
    const requireBuiltin = platform.require;
    // sys only requires util. Its complete source is compiled with its real
    // builtin origin, rather than attributing DEP0025 to the bootstrap caller.
    const source = /* NODE_SYS_SOURCE */;
    function compileFunction(id) {
        return platform.compileSource('(function(exports, require, module, process, internalBinding, primordials) {' + source + '\n})', 'node:' + id);
    }
    function requireWithFallbackInDeps(id) {
        return requireBuiltin(id);
    }
    function internalBinding(name) {
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('sys internal binding ' + name);
    }
    class SysModule {
        constructor() {
            this.id = 'sys';
            this.exports = {};
            this.loaded = false;
            this.loading = false;
        }
        /* NODE_SYS_COMPILE */
    }
    const module = new SysModule();
    return { load() { return module.compileForInternalLoader(); } };
}
