// Full pinned glob traversal/caches/depth/symlink rules over the actual guest
// directory, stat and logical/native realpath owners. No host glob substitute.
function _createNodeGlobPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayFromAsync, PromisePrototypeThen, ReflectApply } = primordials;
    const process = platform.process;
    let globModule, matcher;
    function require(name) {
        if (name === 'fs') return platform.fs;
        if (name === 'fs/promises') return platform.fs.promises;
        if (name === 'path') return platform.path;
        if (name === 'internal/util') return platform.values.util;
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/fs/utils') return platform.dirents;
        if (name === 'internal/assert') return platform.values.require(name);
        if (name === 'internal/url') return { toPathIfFileURL: platform.toPathIfFileURL };
        if (name === 'internal/deps/minimatch/index') {
            if (matcher === undefined) {
                const module = { exports: {} };
                (function(module, exports) {
                    /* NODE_GLOB_MATCHER */
                })(module, module.exports);
                matcher = module.exports;
            }
            return matcher;
        }
        if (name === 'internal/fs/glob') {
            if (globModule === undefined) {
                const module = { exports: {} };
                (function(module, exports, require, primordials, process) {
                    /* NODE_GLOB_MODULE */
                })(module, module.exports, require, primordials, process);
                globModule = module.exports;
            }
            return globModule;
        }
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Glob dependency ' + name);
    }
    const { validateFunction } = platform.values.validators;
    /* NODE_GLOB_LAZY */
    /* NODE_GLOB_CALLBACK */
    function publicAPIs() {
        /* NODE_GLOB_PUBLIC */
        return { glob, globSync };
    }
    function promiseAPIs() {
        /* NODE_GLOB_PROMISES */
        return { glob };
    }
    return { api: publicAPIs(), promises: promiseAPIs(), require };
}
