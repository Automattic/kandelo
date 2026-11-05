// The public path algorithms and glob matcher are pinned Node source. This
// boundary supplies real guest process state and the private module loader.
function _createNodePathPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ObjectCreate, ObjectPrototypeHasOwnProperty, SafeMap, TypeError } = primordials;
    const process = platform.process;
    const isWindows = process.platform === 'win32';
    const isMacOS = process.platform === 'darwin';
    const kEmptyObject = primordials.ObjectFreeze(ObjectCreate(null));
    const factories = {
        /* NODE_PATH_MODULES */
    };
    const modules = new SafeMap();
    function validateString(value, name) {
        return platform.getValues().validators.validateString(value, name);
    }
    modules.set('internal/validators', {
        validateString,
        validateObject(value, name) {
            return platform.getValues().validators.validateObject(value, name);
        },
    });
    const loading = new SafeMap();
    function require(name) {
        if (loading.has(name)) return loading.get(name).exports;
        if (modules.has(name)) return modules.get(name);
        if (!ObjectPrototypeHasOwnProperty(factories, name)) {
            throw new primordials.Error('Unsupported Node path dependency: ' + name);
        }
        const module = { exports: {} };
        loading.set(name, module);
        modules.set(name, module.exports);
        try { factories[name](module, module.exports, require, primordials, process); }
        catch (error) { modules.delete(name); loading.delete(name); throw error; }
        modules.set(name, module.exports);
        loading.delete(name);
        return module.exports;
    }
    modules.set('internal/util', {
        isWindows,
        isMacOS,
        kEmptyObject,
        getLazy: require('internal/util/get_lazy'),
    });
    return require('path');
}
