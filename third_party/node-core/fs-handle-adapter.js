// Public FileHandle methods run pinned descriptor algorithms over actual
// native resources. There is no path reopening or replacement AsyncResource.
function _createNodeFileHandlePlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayPrototypePush, Error, ErrorCaptureStackTrace, FunctionPrototypeBind,
        MathMax, MathMin, Promise, PromisePrototypeThen, PromiseReject, PromiseResolve,
        PromiseWithResolvers, SafeArrayIterator, SafePromisePrototypeFinally,
        SafePromiseRace, Symbol, SymbolAsyncDispose, Uint8Array, uncurryThis } = primordials;
    const process = platform.process;
    const Buffer = platform.Buffer;
    const BufferFrom = Buffer.from;
    const BufferIsBuffer = Buffer.isBuffer;
    const BufferToString = uncurryThis(Buffer.prototype.toString);
    const pathModule = platform.path;
    const EventEmitter = platform.events;
    const StringDecoder = platform.getStringDecoder;
    const assert = platform.values.require('internal/assert');
    const { AbortError, aggregateTwoErrors, codes: { ERR_ACCESS_DENIED, ERR_FS_FILE_TOO_LARGE,
        ERR_INVALID_ARG_VALUE, ERR_INVALID_STATE } } = platform.values.errors;
    const { isArrayBufferView } = platform.types;
    const { kEmptyObject } = platform.values.util;
    const { parseFileMode, validateAbortSignal, validateBoolean, validateBuffer,
        validateEncoding, validateInteger, validateObject, kValidateObjectAllowNullable } = platform.values.validators;
    const { getOptions, copyObject, getValidatedPath, getStatsFromBinding, getReadFileBuffer,
        getReadFileBufferByteLengthName, stringToFlags, toUnixTimestamp,
        validateBufferArray, validateOffsetLengthRead, validateOffsetLengthWrite,
        validatePosition, validateReadFileBufferOptions, validateStringAfterArrayBufferView,
        constants: { kIoMaxLength, kMaxUserId, kReadFileBufferLength,
            kReadFileUnknownBufferLength, kWriteFileMaxChunkSize } } = platform.utils;
    const { S_IFMT, S_IFREG } = platform.fs.constants;
    const vfsState = platform.truncation.vfsState;
    const kUsePromises = Symbol('fs_use_promises_symbol');
    const makeError = platform.truncation.makeError;
    // The guest CLI currently rejects Permission Model activation. This is
    // its actual default-disabled state; kernel permissions still govern I/O.
    // Adding activation requires the real permission owner before this bridge.
    const permission = { isEnabled: () => platform.permissionEnabled() };
    function require(name) { return platform.require(name); }
    function lazyFsStreams() { return require('internal/fs/streams'); }
    function lazyReadableStream() { return require('internal/webstreams/readablestream').ReadableStream; }
    function Interface(options) {
        const { Interface: ActualInterface } = require('internal/readline/interface');
        return new ActualInterface(options);
    }
    function isIterable(value) { return require('internal/streams/utils').isIterable(value); }
    const binding = {
        ReadFileJob: platform.fileJobs.ReadFileJob,
        WriteFileJob: platform.fileJobs.WriteFileJob,
        FileHandle: function FileHandle(fd) { return platform.native.adoptFileHandle(fd, '', makeError); },
        kUsePromises,
        openFileHandle(path, flags, mode) {
            return platform.native.fsOpenPromise(path, flags, mode, makeError);
        },
        read(fd, buffer, offset, length, position) {
            return platform.native.fsIoPromise(false, fd, buffer, offset, length, position, makeError);
        },
        writeBuffer(fd, buffer, offset, length, position) {
            return platform.native.fsIoPromise(true, fd, buffer, offset, length, position, makeError);
        },
        writeString(fd, data, position, encoding) {
            const bytes = BufferFrom(data, encoding);
            return platform.native.fsIoPromise(true, fd, bytes, 0, bytes.byteLength, position, makeError);
        },
        readBuffers(fd, buffers, position) { return platform.native.fsVectorPromise(false, fd, buffers, position, makeError); },
        writeBuffers(fd, buffers, position) { return platform.native.fsVectorPromise(true, fd, buffers, position, makeError); },
        stat(path, bigint, unused, throwIfNoEntry) { return platform.native.fsStatPromise(path, bigint, makeError, true, throwIfNoEntry); },
        lstat(path, bigint) { return platform.native.fsStatPromise(path, bigint, makeError, false); },
        fstat(fd, bigint) { return platform.native.fsStatPromise(fd, bigint, makeError); },
        ftruncate(fd, length) { return platform.native.fsControlPromise('ftruncate', fd, length, undefined, makeError); },
        fsync(fd) { return platform.native.fsControlPromise('fsync', fd, undefined, undefined, makeError); },
        fdatasync(fd) { return platform.native.fsControlPromise('fdatasync', fd, undefined, undefined, makeError); },
        fchmod(fd, mode) { return platform.native.fsControlPromise('fchmod', fd, mode, undefined, makeError); },
        fchown(fd, uid, gid) { return platform.native.fsControlPromise('fchown', fd, uid, gid, makeError); },
        futimes(fd, atime, mtime) { return platform.native.fsControlPromise('futimes', fd, atime, mtime, makeError); },
    };
    /* NODE_FILE_HANDLE */
    return { FileHandle, open, truncate, readFile, writeFile, appendFile, stat, lstat, kRef, kUnref, kCloseSync,
        descriptorReadFile: readFile, descriptorWriteFile: writeFile };
}
