// Complete pinned logical/native realpath and readlink public owners. Native
// byte results come from real libc operations and actual queued FS requests.
function _createNodeRealpathPlatform(platform) {
    'use strict';
    const { BigIntPrototypeToString, ErrorCaptureStackTrace, Number, PromisePrototypeThen,
        PromiseReject, ReflectApply, RegExpPrototypeExec: SideEffectFreeRegExpPrototypeExec,
        SafeMap, SafeSet, StringPrototypeCharCodeAt, StringPrototypeIndexOf,
        StringPrototypeSlice, Symbol } = _createNodePrimordials();
    const process = platform.process, fs = platform.fs, pathModule = platform.path, Buffer = platform.Buffer;
    const { codes: { ERR_ACCESS_DENIED } } = platform.values.errors;
    const { validateFunction } = platform.values.validators;
    const { getOptions, getValidatedPath, validatePath, realpathCacheKey } = platform.utils;
    const { FSReqCallback, vfsState, makeError } = platform.truncation;
    const { S_IFMT, S_IFLNK, S_IFIFO, S_IFSOCK } = fs.constants;
    const { isWindows } = platform.values.util;
    const toPathIfFileURL = platform.toPathIfFileURL;
    const permission = platform.permission;
    const CHAR_FORWARD_SLASH = 47, CHAR_BACKWARD_SLASH = 92;
    const kUsePromises = Symbol('realpath_use_promises');
    function read(name, path, encoding, request) {
        const convert = bytes => encoding === 'buffer' ?
            platform.codecs.copyBytes(bytes) : platform.codecs.decodeBytes(bytes, encoding);
        if (request !== undefined) return platform.native.fsMetadataPromise(name, path, undefined, undefined,
            request === kUsePromises ? makeError : request, convert);
        const value = platform.native.fsMetadataSync(name, path, undefined, undefined, convert);
        if (typeof value === 'number' && value < 0) throw makeError(value, name, path);
        return value;
    }
    function stat(path, follow, bigint, throwIfNoEntry) {
        const value = platform.native.fsStatSync(path, follow, bigint);
        if (typeof value === 'number' && value < 0) {
            if (!throwIfNoEntry && (value === -2 || value === -20)) return undefined;
            throw makeError(value, follow ? 'stat' : 'lstat', path);
        }
        return value;
    }
    const binding = {
        realpath: (path, encoding, request) => read('realpath', path, encoding, request),
        readlink: (path, encoding, request) => read('readlink', path, encoding, request),
        stat: (path, bigint, unused, throwIfNoEntry) => stat(path, true, bigint, throwIfNoEntry),
        lstat: (path, bigint, unused, throwIfNoEntry) => stat(path, false, bigint, throwIfNoEntry),
    };
    // The Windows-only root regexes are private owned literals. The saved
    // RegExp exec intrinsic cannot be replaced through public prototypes.
    /* NODE_REALPATH_SHARED */
    function publicAPIs() {
        /* NODE_REALPATH_PUBLIC */
        return { realpath, realpathSync, readlink, readlinkSync };
    }
    function promiseAPIs() {
        /* NODE_REALPATH_PROMISES */
        return { realpath, readlink };
    }
    return { api: publicAPIs(), promises: promiseAPIs() };
}
