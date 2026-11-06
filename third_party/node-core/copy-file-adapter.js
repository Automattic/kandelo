// Pinned public copyFile wrappers over real native descriptor/queue ownership.
function _createNodeCopyFile(platform) {
    'use strict';
    const { ErrorCaptureStackTrace, ReflectApply, PromisePrototypeThen, PromiseReject,
        Symbol, MathTrunc, NumberIsFinite, TypeError, RangeError, ObjectDefineProperty } = _createNodePrimordials();
    const { validateFunction } = platform.values.validators;
    const { getValidatedPath } = platform.utils;
    const { FSReqCallback, vfsState, makeError } = platform.truncation;
    const kUsePromises = Symbol('copyfile_use_promises');
    function copyMode(mode) {
        if (mode === null || mode === undefined) return 0;
        let error;
        if (typeof mode !== 'number') {
            error = new TypeError('mode must be int32 or null/undefined');
            ObjectDefineProperty(error, 'code', { __proto__: null, value: 'ERR_INVALID_ARG_TYPE', enumerable: true, writable: true, configurable: true });
        } else if (!NumberIsFinite(mode)) {
            error = new RangeError('mode is out of range');
        } else {
            mode = MathTrunc(mode);
            if (mode >= 0 && mode <= 7) return mode;
            error = new RangeError('mode is out of range: >= 0 && <= 7');
        }
        if (typeof mode === 'number') ObjectDefineProperty(error, 'code', {
            __proto__: null, value: 'ERR_OUT_OF_RANGE', enumerable: true, writable: true, configurable: true });
        throw error;
    }
    const binding = {
        copyFile(src, dest, mode, request) {
            mode = copyMode(mode);
            if (request !== undefined) return platform.native.fsCopyFile(src, dest, mode,
                request === kUsePromises ? makeError : request);
            const status = platform.native.fsCopyFileSync(src, dest, mode);
            if (status < 0) throw makeError(status, 'copyfile', src, dest);
        },
    };
    /* NODE_COPY_FILE_SHARED */
    function publicAPIs() {
        /* NODE_COPY_FILE_PUBLIC */
        return { copyFile, copyFileSync };
    }
    function promiseAPIs() {
        /* NODE_COPY_FILE_PROMISE */
        return { copyFile };
    }
    return { api: publicAPIs(), promises: promiseAPIs() };
}
