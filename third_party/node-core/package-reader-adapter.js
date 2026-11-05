// Actual pinned reader/cache over the real native parser and POSIX file owner.
function _createNodePackageReader(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { Error, ObjectPrototypeHasOwnProperty, StringPrototypeEndsWith,
        ObjectGetOwnPropertyDescriptor, uncurryThis, ReflectApply,
        MapPrototypeForEach, StringPrototypeStartsWith, ArrayPrototypeForEach, ObjectKeys } = primordials;
    const { URL, fileURLToPath } = platform.url;
    const path = platform.path;
    const getPathname = uncurryThis(ObjectGetOwnPropertyDescriptor(URL.prototype, 'pathname').get);
    const urlCanParse = URL.canParse;
    /* NODE_PACKAGE_CLEAN_VFS */
    const owner = platform.native.packageOperation();
    function unwrap(path, nearest = false, isESM = false, base, specifier) {
        platform.checkPermission(path);
        const packet = platform.native.packageOperation(owner, path, nearest);
        if (packet[0] === 0) return packet[1];
        if (packet[0] === 1) return undefined;
        const jsonPath = packet[3];
        let message;
        if (packet[0] === 3) {
            message = `Cannot read package config ${jsonPath}: ${platform.errorMessage(packet[2])}.`;
        } else if (packet[0] === 2) {
            message = isESM && base !== undefined ?
                `Invalid package config ${jsonPath} while importing "${specifier}" from ${fileURLToPath(base)}.` :
                `Invalid package config ${jsonPath}.`;
        } else throw new Error('Invalid native package cache result');
        const error = new Error(message);
        error.code = 'ERR_INVALID_PACKAGE_CONFIG';
        throw error;
    }
    function scope(resolved, onlyType) {
        let candidate = new URL('./package.json', resolved);
        for (;;) {
            if (StringPrototypeEndsWith(getPathname(candidate), '/node_modules/package.json')) break;
            const filename = fileURLToPath(candidate);
            const result = unwrap(filename, false, true, undefined, resolved);
            if (result !== undefined) return onlyType ? result[2] : result;
            const lastPath = getPathname(candidate);
            candidate = new URL('../package.json', candidate);
            if (getPathname(candidate) === lastPath) break;
        }
        return onlyType ? undefined : fileURLToPath(candidate);
    }
    const loaderMethods = {
        readPackageJSON: (path, isESM, base, specifier) => unwrap(path, false, isESM === true, base, specifier),
        getNearestParentPackageJSON: path => unwrap(path, true),
        getPackageScopeConfig: resolved => scope(resolved, false),
        getPackageType: resolved => scope(resolved, true),
        getResolutionRoot: path => platform.getResolutionRoot(path),
        internalModuleStat: path => platform.stat(path),
    };
    const module = { exports: {} };
    const modules = {
        'internal/url': platform.url,
        'internal/errors': platform.values.errors,
        'internal/util': platform.values.util,
        'internal/validators': platform.values.validators,
        'internal/process/permission': { isEnabled: platform.permissionEnabled },
        path: platform.path,
        'internal/modules/helpers': { loaderMethods, cleanForVfsPrefix },
    };
    function require(name) {
        if (name === 'internal/modules/esm/resolve') return platform.getESMResolver();
        if (!ObjectPrototypeHasOwnProperty(modules, name)) throw new Error('Unimplemented package reader dependency: ' + name);
        return modules[name];
    }
    function internalBinding(name) {
        if (name === 'url') return { canParse: (...args) => ReflectApply(urlCanParse, URL, args) };
        throw new Error('Unimplemented package reader binding: ' + name);
    }
    (function(module, exports, require, primordials, internalBinding) {
        /* NODE_PACKAGE_READER */
    })(module, module.exports, require, primordials, internalBinding);
    return module.exports;
}
