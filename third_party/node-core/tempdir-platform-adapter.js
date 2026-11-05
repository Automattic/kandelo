// Pinned temporary/disposable directory APIs over actual guest libc requests.
function _createNodeTempdirPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ErrorCaptureStackTrace, PromisePrototypeThen, PromiseReject, ReflectApply,
        StringPrototypeEndsWith, Symbol, SymbolDispose, SymbolAsyncDispose,
        TypedArrayPrototypeAt } = primordials;
    const process = platform.process, pathModule = platform.path;
    const { validateFunction } = platform.values.validators;
    const { getOptions, getValidatedPath } = platform.utils;
    const { vfsState, FSReqCallback, makeError } = platform.truncation;
    const kUsePromises = Symbol('tempdir_use_promises');
    const lazyRimRaf = platform.removal.lazyRimRaf;
    function create(prefix, encoding, request) {
        const convert = bytes => encoding === 'buffer' ?
            platform.codecs.copyBytes(bytes) : platform.codecs.decodeBytes(bytes, encoding);
        if (request !== undefined)
            return platform.native.fsPathPromise('mkdtemp', prefix, 0, false,
                request === kUsePromises ? makeError : request, convert);
        const result = platform.native.fsPathSync('mkdtemp', prefix, 0, false);
        if (typeof result === 'number' && result < 0)
            throw makeError(result, 'mkdtemp', typeof prefix === 'string' ?
                prefix + 'XXXXXX' : platform.codecs.decodeBytes(prefix) + 'XXXXXX');
        return convert(result);
    }
    const binding = { mkdtemp: create, rmSync: platform.removal.binding.rmSync };
    /* NODE_TEMPDIR_SHARED */
    function publicAPIs() {
        /* NODE_TEMPDIR_PUBLIC */
        return { mkdtemp, mkdtempSync, mkdtempDisposableSync };
    }
    function promiseAPIs() {
        /* NODE_TEMPDIR_PROMISES */
        return { mkdtemp, mkdtempDisposable };
    }
    return { api: publicAPIs(), promises: promiseAPIs() };
}
