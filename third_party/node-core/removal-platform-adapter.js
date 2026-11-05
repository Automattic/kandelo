// Pinned removal validation/rimraf over actual FS requests and native paths.
function _createNodeRemovalPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { Error, PromisePrototypeThen } = primordials;
    const { hideStackFrames, UVException, codes: { ERR_FS_EISDIR } } = platform.values.errors;
    const { validateBoolean, validateInt32, validateUint32 } = platform.values.validators;
    const { getValidatedPath } = platform.utils;
    const { vfsState, FSReqCallback, makeError } = platform.truncation;
    const { EISDIR } = platform.errno;
    const { validateRmdirOptions } = platform.directory;
    const lazyLoadFs = () => platform.fs;
    const isWindows = platform.process.platform === 'win32';
    const BufferPrototype = platform.Buffer.prototype;
    let rimrafModule;
    function loadRimraf() {
        if (rimrafModule !== undefined) return rimrafModule;
        const module = { exports: {} };
        const dependencies = {
            buffer: { Buffer: platform.Buffer },
            fs: { chmod: platform.fs.chmod, lstat: platform.fs.lstat,
                stat: platform.fs.stat, rmdir: platform.fs.rmdir, unlink: platform.fs.unlink,
                readdir(path, encoding, callback) {
                    const req = new FSReqCallback();
                    req.oncomplete = callback;
                    return platform.native.fsScandir(path, req, BufferPrototype);
                } },
            path: platform.path,
            timers: platform.timers,
            'internal/util': { isWindows },
        };
        rimrafFactory(module, module.exports, name => dependencies[name], primordials);
        rimrafModule = module.exports;
        return rimrafModule;
    }
    let rimraf;
    function lazyLoadRimraf() { rimraf = loadRimraf().rimraf; }
    const lazyRimRaf = () => loadRimraf().rimrafPromises;
    const validateRmOptionsPromise = (...args) => new primordials.Promise((resolve, reject) =>
        validateRmOptions(...args, (error, options) => error ? reject(error) : resolve(options)));
    const binding = { rmSync(path, maxRetries, recursive, retryDelay) {
        const packet = platform.native.fsRmSync(path, maxRetries, recursive, retryDelay);
        if (packet === undefined) return;
        if (packet[1]) {
            const error = new Error(packet[3]);
            error.code = 'ERR_FS_EISDIR';
            throw error;
        }
        throw new UVException({ errno: packet[2] ? platform.uv.binding.UV_UNKNOWN : -packet[0],
            syscall: 'rm', path: packet[4], message: packet[3] });
    } };
    function vfsVoid(promise, callback) {
        if (promise === undefined) return false;
        PromisePrototypeThen(promise, () => callback(null), callback);
        return true;
    }
    const rimrafFactory = function(module, exports, require, primordials) {
        /* NODE_REMOVAL_RIMRAF */
    };
    /* NODE_REMOVAL_VALIDATION */
    function publicAPIs() {
        /* NODE_REMOVAL_PUBLIC */
        return { rm, rmSync };
    }
    function promiseAPIs() {
        /* NODE_REMOVAL_PROMISE */
        return { rm };
    }
    return { api: publicAPIs(), promises: promiseAPIs() };
}
