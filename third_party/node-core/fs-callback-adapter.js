// Pinned callback APIs dispatch actual FSReqCallback owners, not promises or
// synchronous I/O hidden behind microtasks. Bindings share the native jobs.
function _createNodeFsCallbacks(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ReflectApply, FunctionPrototypeCall, ObjectDefineProperty, PromisePrototypeThen, uncurryThis } = primordials;
    const Buffer = platform.Buffer;
    const fs = platform.fs;
    const BufferFrom = Buffer.from;
    const BufferIsBuffer = Buffer.isBuffer;
    const BufferToString = uncurryThis(Buffer.prototype.toString);
    const process = platform.process;
    const { AbortError, aggregateTwoErrors, codes: { ERR_ACCESS_DENIED, ERR_FS_FILE_TOO_LARGE, ERR_INVALID_ARG_VALUE } } = platform.values.errors;
    const { isArrayBufferView } = platform.types;
    const { kEmptyObject, customPromisifyArgs: kCustomPromisifyArgsSymbol } = platform.values.util;
    const { isInt32, validateFunction, validateInt32, validateObject, validateBuffer, validateInteger,
        validateEncoding, validateAbortSignal, validateBoolean, parseFileMode, kValidateObjectAllowNullable } = platform.values.validators;
    const { getOptions, copyObject, getValidatedPath, getValidatedFd, getStatsFromBinding,
        stringToFlags, toUnixTimestamp, validateBufferArray, validatePosition,
        validateOffsetLengthRead, validateOffsetLengthWrite, validateStringAfterArrayBufferView,
        validateReadFileBufferOptions, constants: { kMaxUserId, kIoMaxLength, kReadFileBufferLength } } = platform.utils;
    const { FSReqCallback, vfsState } = platform.truncation;
    const permission = { isEnabled: () => platform.permissionEnabled() };
    let kResistStopPropagation;
    const isFd = isInt32;
    const { S_IFMT, S_IFREG } = platform.fs.constants;
    let ReadFileContext, readContextModule;
    function require(name) {
        if (name !== 'internal/fs/read/context') return platform.require(name);
        if (!readContextModule) {
            const module = { exports: {} };
            readContextFactory(module, module.exports, name => name === 'internal/fs/utils' ? platform.utils :
                name === 'buffer' ? { Buffer } : name === 'internal/errors' ? platform.values.errors : platform.require(name),
                primordials, name => {
                    if (name === 'fs') return binding;
                    throw new TypeError('Unknown read context binding: ' + name);
                }, process);
            readContextModule = module.exports;
        }
        return readContextModule;
    }
    const ReadFileJob = platform.fileJobs.ReadFileJob;
    const WriteFileJob = platform.fileJobs.WriteFileJob;
    const binding = {
        FSReqCallback,
        close(fd, req) { return platform.native.closeDescriptor(fd, req); },
        open(path, flags, mode, req) { return platform.native.fsOpenPromise(path, flags, mode, req); },
        read(fd, buffer, offset, length, position, req) {
            return platform.native.fsIoPromise(false, fd, buffer, offset, length, position, req);
        },
        writeBuffer(fd, buffer, offset, length, position, req) {
            return platform.native.fsIoPromise(true, fd, buffer, offset, length, position, req);
        },
        writeString(fd, text, position, encoding, req) {
            const buffer = BufferFrom(text, encoding);
            return platform.native.fsIoPromise(true, fd, buffer, 0, buffer.byteLength, position, req);
        },
        readBuffers(fd, buffers, position, req) { return platform.native.fsVectorPromise(false, fd, buffers, position, req); },
        writeBuffers(fd, buffers, position, req) { return platform.native.fsVectorPromise(true, fd, buffers, position, req); },
        fstat(fd, bigint, req) {
            validateInt32(fd, 'fd', 0);
            return platform.native.fsStatPromise(fd, bigint, req);
        },
        stat(path, bigint, req, throwIfNoEntry) { return platform.native.fsStatPromise(path, bigint, req, true, throwIfNoEntry); },
        lstat(path, bigint, req) { return platform.native.fsStatPromise(path, bigint, req, false); },
        fchmod(fd, mode, req) { validateInt32(fd, 'fd', 0); return platform.native.fsControlPromise('fchmod', fd, mode, undefined, req); },
        fchown(fd, uid, gid, req) { validateInt32(fd, 'fd', 0); return platform.native.fsControlPromise('fchown', fd, uid, gid, req); },
        futimes(fd, atime, mtime, req) { validateInt32(fd, 'fd', 0); return platform.native.fsControlPromise('futimes', fd, atime, mtime, req); },
        fsync(fd, req) { validateInt32(fd, 'fd', 0); return platform.native.fsControlPromise('fsync', fd, undefined, undefined, req); },
        fdatasync(fd, req) { validateInt32(fd, 'fd', 0); return platform.native.fsControlPromise('fdatasync', fd, undefined, undefined, req); },
    };
    const readContextFactory = function(module, exports, require, primordials, internalBinding, process) {
        /* NODE_FS_READ_CONTEXT */
    };
    /* NODE_FS_CALLBACKS */
    return { open, readFile, writeFile, appendFile, read, write, readv, writev, stat, lstat, fstat,
        fchmod, fchown, futimes, fsync, fdatasync };
}
