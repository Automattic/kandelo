// Full pinned public wrappers; metadata comes from actual POSIX operations.
function _createNodePathMetadata(platform) {
    'use strict';
    const { ErrorCaptureStackTrace, ReflectApply, PromisePrototypeThen, PromiseReject, Symbol,
        MathTrunc, NumberIsFinite, TypeError, RangeError, ObjectDefineProperty } = _createNodePrimordials();
    const { parseFileMode, validateFunction, validateInteger } = platform.values.validators;
    const { getValidatedPath, toUnixTimestamp, constants: { kMaxUserId } } = platform.utils;
    const { FSReqCallback, vfsState, makeError } = platform.truncation;
    const { F_OK, R_OK, W_OK, X_OK } = platform.constants;
    const maximumAccessMode = F_OK | R_OK | W_OK | X_OK;
    const kUsePromises = Symbol('metadata_use_promises');
    // GetValidFileMode uses native Number-to-integer conversion, accepting
    // finite fractional inputs before the range check. A stricter JS int32
    // validator would reject inputs the target accepts.
    function accessMode(mode) {
        if (mode === null || mode === undefined) return F_OK;
        let error;
        if (typeof mode !== 'number') {
            error = new TypeError('mode must be int32 or null/undefined');
            ObjectDefineProperty(error, 'code', { __proto__: null, value: 'ERR_INVALID_ARG_TYPE', enumerable: true, writable: true, configurable: true });
        } else if (!NumberIsFinite(mode)) {
            error = new RangeError('mode is out of range');
        } else {
            mode = MathTrunc(mode);
            if (mode >= F_OK && mode <= maximumAccessMode) return mode;
            error = new RangeError(`mode is out of range: >= ${F_OK} && <= ${maximumAccessMode}`);
        }
        if (typeof mode === 'number') ObjectDefineProperty(error, 'code', {
            __proto__: null, value: 'ERR_OUT_OF_RANGE', enumerable: true, writable: true, configurable: true });
        throw error;
    }
    function operation(name, path, first, second, request) {
        if (name === 'access') first = accessMode(first);
        if (request !== undefined) return platform.native.fsMetadataPromise(name, path, first, second,
            request === kUsePromises ? makeError : request);
        const status = platform.native.fsMetadataSync(name, path, first, second);
        if (status < 0) throw makeError(status, name === 'utimes' ? 'utime' : name === 'lutimes' ? 'lutime' : name, path);
    }
    const binding = {
        access: (path, mode, req) => operation('access', path, mode, undefined, req),
        chmod: (path, mode, req) => operation('chmod', path, mode, undefined, req),
        chown: (path, uid, gid, req) => operation('chown', path, uid, gid, req),
        lchown: (path, uid, gid, req) => operation('lchown', path, uid, gid, req),
        utimes: (path, atime, mtime, req) => operation('utimes', path, atime, mtime, req),
        lutimes: (path, atime, mtime, req) => operation('lutimes', path, atime, mtime, req),
    };
    /* NODE_METADATA_SHARED */
    function publicAPIs() {
        /* NODE_METADATA_PUBLIC */
        return { access, accessSync, chmod, chmodSync, chown, chownSync,
            lchown, lchownSync, utimes, utimesSync, lutimes, lutimesSync };
    }
    function promiseAPIs() {
        /* NODE_METADATA_PROMISES */
        return { access, chmod, chown, lchown, utimes, lutimes };
    }
    return { api: publicAPIs(), promises: promiseAPIs() };
}
