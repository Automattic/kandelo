// Native UVException field/presence order over actual guest libuv error data.
// In particular, an empty path is present and raw path bytes decode as UTF-8.
function _createNodeFsSystemErrors(platform) {
    'use strict';
    const { Error, MapPrototypeGet, MathAbs, ObjectDefineProperty } = _createNodePrimordials();
    const errors = platform.uv.binding.getErrorMap();
    const decode = platform.codecs.decodeBytes;
    function pathString(path) { return typeof path === 'string' ? path : decode(path, 'utf8'); }
    function define(error, name, value) {
        ObjectDefineProperty(error, name, { __proto__: null, value,
            enumerable: true, writable: true, configurable: true });
    }
    function fromStatus(status, syscall, path, dest) {
        const entry = MapPrototypeGet(errors, status);
        const code = entry === undefined ? platform.uv.getSystemErrorName(status) : entry[0];
        const reason = entry === undefined ? platform.uv.binding.getErrorMessage(status) : entry[1];
        let message = `${code}: ${reason}, ${syscall}`;
        const hasPath = path !== undefined && path !== null;
        const hasDest = dest !== undefined && dest !== null;
        if (hasPath) { path = pathString(path); message += ` '${path}'`; }
        if (hasDest) { dest = pathString(dest); message += ` -> '${dest}'`; }
        const error = new Error(message);
        define(error, 'errno', status); define(error, 'code', code); define(error, 'syscall', syscall);
        if (hasPath) define(error, 'path', path);
        if (hasDest) define(error, 'dest', dest);
        return error;
    }
    return { fromStatus, fromErrno: (errno, syscall, path, dest) => fromStatus(-MathAbs(errno), syscall, path, dest) };
}
