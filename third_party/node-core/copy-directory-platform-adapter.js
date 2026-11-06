// Complete pinned cp algorithms over actual native directory-copy ownership.
function _createNodeCopyDirectoryPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { Error, MathMin, ObjectDefineProperty, ObjectPrototypeHasOwnProperty, ReflectApply } = primordials;
    const process = platform.process;
    const { hideStackFrames, codes: { ERR_INCOMPATIBLE_OPTION_PAIR } } = platform.values.errors;
    const { validateBoolean, validateFunction, validateInteger, validateObject } = platform.values.validators;
    const { getValidatedPath } = platform.utils;
    const { F_OK, R_OK, W_OK, X_OK, COPYFILE_EXCL, COPYFILE_FICLONE, COPYFILE_FICLONE_FORCE } = platform.fs.constants;
    const assert = (...args) => ReflectApply(platform.getAssert(), undefined, args);
    /* NODE_COPY_DIRECTORY_VALIDATORS */
    // Native C++ cp errors are plain Error objects, distinct from the pinned
    // JS walk's SystemError subclasses. Record fields have native own storage.
    function fromNative(packet) {
        if (packet === undefined || packet[0] === 0) return null;
        const kind = packet[0], status = packet[1], syscall = packet[2];
        const message = packet[3], path = packet[4], dest = packet[5];
        let error;
        if (kind === 1) {
            const code = status === 0 ? '' : platform.values.util.getSystemErrorName(-status);
            error = new Error(`${code}, ${message} '${path}'`);
            error.errno = status; error.code = code; error.path = path; error.syscall = syscall;
        } else if (kind === 2) {
            const code = platform.values.util.getSystemErrorName(status);
            const description = platform.values.util.getSystemErrorMessage(status);
            error = new Error(`${code}: ${description}, ${syscall} '${path}'` +
                (dest === undefined ? '' : ` -> '${dest}'`));
            error.errno = status; error.code = code; error.syscall = syscall; error.path = path;
            if (dest !== undefined) error.dest = dest;
        } else {
            const codes = { __proto__: null, 3: 'ERR_FS_CP_EINVAL',
                4: 'ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY', 5: 'ERR_FS_CP_EEXIST',
                6: 'ERR_FS_CP_SOCKET', 7: 'ERR_FS_CP_FIFO_PIPE', 8: 'ERR_FS_CP_UNKNOWN',
                9: 'ERR_FS_CP_DIR_TO_NON_DIR', 10: 'ERR_FS_CP_NON_DIR_TO_DIR', 11: 'ERR_FS_EISDIR' };
            error = new Error(message);
            // Pinned C++ coded errors use Object::Set. Preserve observable
            // inherited setters here; only internal packets require own data.
            error.code = codes[kind];
        }
        return error;
    }
    function finishSync(packet) {
        const error = fromNative(packet);
        if (error !== null) throw error;
    }
    class CpDirJob {
        constructor(src, dest, force, dereference, errorOnExist, verbatimSymlinks, preserveTimestamps, mode) {
            return platform.native.createCpDirJob(CpDirJob.prototype, src, dest, force, dereference,
                errorOnExist, verbatimSymlinks, preserveTimestamps, mode, fromNative);
        }
        run() { return platform.native.runCpDirJob(this); }
    }
    const fsBinding = {
        CpDirJob,
        cpSyncCheckPaths(src, dest, dereference, recursive) {
            return finishSync(platform.native.cpSyncCheckPaths(src, dest, dereference, recursive));
        },
        cpSyncOverrideFile(src, dest, mode, preserveTimestamps) {
            // Pinned GetValidFileMode defaults null/undefined to copy mode0.
            return finishSync(platform.native.cpSyncOverrideFile(src, dest, mode ?? 0, preserveTimestamps));
        },
        cpSyncCopyDir(src, dest, force, dereference, errorOnExist, verbatimSymlinks, preserveTimestamps) {
            return finishSync(platform.native.cpSyncCopyDir(src, dest, force, dereference,
                errorOnExist, verbatimSymlinks, preserveTimestamps));
        },
        internalModuleStat: platform.internalModuleStat,
    };
    const moduleFactories = {
        /* NODE_COPY_DIRECTORY_MODULES */
    };
    const cache = { __proto__: null };
    function require(name) {
        if (ObjectPrototypeHasOwnProperty(cache, name)) return cache[name].exports;
        if (name === 'fs') return platform.fs;
        if (name === 'fs/promises') return platform.fs.promises;
        if (name === 'path') return platform.path;
        if (name === 'util') return platform.util;
        if (name === 'util/types') return platform.types;
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/assert') return platform.getAssert();
        if (name === 'internal/process/permission') return platform.permission;
        if (!ObjectPrototypeHasOwnProperty(moduleFactories, name))
            throw new Error('Unimplemented cp dependency: ' + name);
        const module = { exports: {} };
        cache[name] = module;
        moduleFactories[name](module, module.exports, require, primordials, internalBinding, process);
        return module.exports;
    }
    function internalBinding(name) {
        if (name === 'fs') return fsBinding;
        if (name === 'constants') return platform.constants;
        throw new Error('Unimplemented cp binding: ' + name);
    }
    let cpFn, cpSyncFn;
    /* NODE_COPY_DIRECTORY_LAZY */
    /* NODE_COPY_DIRECTORY_MAKE_CALLBACK */
    function publicAPIs() {
        /* NODE_COPY_DIRECTORY_PUBLIC */
        return { cp, cpSync };
    }
    let cpPromises;
    /* NODE_COPY_DIRECTORY_PROMISE_LAZY */
    function promiseAPIs() {
        /* NODE_COPY_DIRECTORY_PROMISE */
        return { cp };
    }
    return { api: publicAPIs(), promises: promiseAPIs(), binding: fsBinding };
}
