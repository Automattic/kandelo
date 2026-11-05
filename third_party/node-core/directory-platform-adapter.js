// Pinned directory/path APIs over actual distinct guest libc operations.
function _createNodeDirectoryPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ErrorCaptureStackTrace, PromisePrototypeThen, PromiseReject,
        ReflectApply, Symbol } = primordials;
    const { hideStackFrames, codes: { ERR_INVALID_ARG_VALUE } } = platform.values.errors;
    const { parseFileMode, validateBoolean, validateFunction, validateObject } = platform.values.validators;
    const { getValidatedPath } = platform.utils;
    const { kEmptyObject } = platform.values.util;
    const { vfsState, FSReqCallback, makeError } = platform.truncation;
    const kUsePromises = Symbol('directory_use_promises');
    function pathOperation(name, path, mode, recursive, request) {
        if (request !== undefined)
            return platform.native.fsPathPromise(name, path, mode, recursive,
                request === kUsePromises ? makeError : request);
        const value = platform.native.fsPathSync(name, path, mode, recursive);
        if (typeof value === 'number' && value < 0) throw makeError(value, name, path);
        return value;
    }
    const binding = {
        mkdir: (path, mode, recursive, request) => pathOperation('mkdir', path, mode, recursive, request),
        unlink: (path, request) => pathOperation('unlink', path, 0, false, request),
        rmdir: (path, request) => pathOperation('rmdir', path, 0, false, request),
    };
    /* NODE_DIRECTORY_SHARED */
    function publicAPIs() {
        /* NODE_DIRECTORY_PUBLIC */
        return { mkdir, mkdirSync, unlink, unlinkSync, rmdir, rmdirSync };
    }
    function promiseAPIs() {
        /* NODE_DIRECTORY_PROMISES */
        return { mkdir, unlink, rmdir };
    }
    return { api: publicAPIs(), promises: promiseAPIs(), validateRmdirOptions };
}
