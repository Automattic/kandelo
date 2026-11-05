// Public file loading over the native guest file and environment owners.
function _createNodeDotenvPlatform(platform) {
    'use strict';
    const { Error, TypeError } = _createNodePrimordials();
    const { getSystemErrorName, getSystemErrorMessage } = platform.values.util;
    function fileError(errno, syscall, path) {
        // Native UVException receives a provided path even when it is empty.
        // The separate JS UVException helper omits falsy paths instead.
        const code = getSystemErrorName(errno);
        const error = new Error(`${code}: ${getSystemErrorMessage(errno)}, ${syscall} '${path}'`);
        error.errno = errno; error.code = code; error.syscall = syscall; error.path = path;
        return error;
    }
    let getValidatedPath;
    function require(name) {
        if (name === 'internal/fs/utils') return platform.utils;
        throw new Error('Unknown dotenv dependency: ' + name);
    }
    function _loadEnvFile(path = '.env') {
        const result = platform.native.loadEnvFile(path);
        if (result === undefined) return;
        if (result.kind === 'open') {
            // The exact native LoadEnvFile API reports ENOENT for any open
            // failure. The private result retains the actual errno separately.
            throw fileError(platform.uv.binding.UV_ENOENT, 'open', result.path);
        }
        if (result.kind === 'read') {
            const error = new TypeError(`Contents of '${result.path}' should be a valid string.`);
            error.code = 'ERR_INVALID_ARG_TYPE';
            throw error;
        }
        // Target native code aborts on failed close. This visible error is
        // still an unresolved embedding policy deviation, never success.
        throw fileError(result.errno, 'close', result.path);
    }
    /* NODE_LOAD_ENV_FILE */
    return { loadEnvFile };
}
