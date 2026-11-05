// Pinned filesystem utilities and Stats over the guest's actual stat record.
// Shared by descriptor promises, sync metadata and future filesystem streams.
function _createNodeFsStats(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayIsArray, BigInt, Date, DateNow, DatePrototypeGetTime,
        MathFloor, MathRound, Number, NumberIsFinite, ObjectDefineProperties,
        ObjectIs, ObjectSetPrototypeOf, ReflectOwnKeys, ErrorCaptureStackTrace, FunctionPrototypeCall,
        StringPrototypeIncludes, Symbol, TypedArrayPrototypeIncludes, uncurryThis } = primordials;
    const { isArrayBufferView, isBigInt64Array, isDate, isUint8Array } = platform.types;
    const { setOwnProperty, kEmptyObject } = platform.values.util;
    const { hideStackFrames, UVException, codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE,
        ERR_ACCESS_DENIED, ERR_NO_TEMPORAL, ERR_OUT_OF_RANGE } } = platform.values.errors;
    const { parseFileMode, validateAbortSignal, validateBuffer, validateInt32, validateInteger, validateObject, validateEncoding, kValidateObjectAllowNullable } = platform.values.validators;
    const Buffer = platform.Buffer;
    const BufferFrom = Buffer.from;
    const BufferIsBuffer = Buffer.isBuffer;
    const BufferToString = uncurryThis(Buffer.prototype.toString);
    const toPathIfFileURL = platform.toPathIfFileURL;
    const isWindows = platform.process.platform === 'win32';
    const { S_IFMT, S_IFREG, S_IFDIR, S_IFCHR, S_IFBLK,
        S_IFIFO, S_IFLNK, S_IFSOCK, O_RDONLY, O_RDWR, O_WRONLY,
        O_SYNC, O_TRUNC, O_CREAT, O_EXCL, O_APPEND } = platform.fs.constants;
    const vfsState = platform.truncation.vfsState;
    const permission = { isEnabled: () => platform.permissionEnabled() };
    function result(value, syscall, path, throwIfNoEntry = true) {
        if (typeof value === 'number' && value < 0) {
            if (!throwIfNoEntry && (value === -2 || value === -20)) return undefined;
            platform.throwErrno(-value, syscall, path);
        }
        return value;
    }
    function control(name, fd, first, second) {
        validateInt32(fd, 'fd', 0);
        return result(platform.native.fsControlSync(name, fd, first, second), name === 'futimes' ? 'futime' : name);
    }
    const binding = {
        open(path, flags, mode) { return result(platform.native.fsOpenSync(path, flags, mode), 'open', path); },
        read(fd, buffer, offset, length, position) {
            validateInt32(fd, 'fd', 0);
            return result(platform.native.fsIoSync(false, fd, buffer, offset, length, position), 'read');
        },
        writeBuffer(fd, buffer, offset, length, position) {
            validateInt32(fd, 'fd', 0);
            return result(platform.native.fsIoSync(true, fd, buffer, offset, length, position), 'write');
        },
        writeString(fd, text, position, encoding) {
            const buffer = BufferFrom(text, encoding);
            return binding.writeBuffer(fd, buffer, 0, buffer.byteLength, position);
        },
        readBuffers(fd, buffers, position) {
            validateInt32(fd, 'fd', 0);
            return result(platform.native.fsVectorSync(false, fd, buffers, position), 'read');
        },
        writeBuffers(fd, buffers, position) {
            validateInt32(fd, 'fd', 0);
            return result(platform.native.fsVectorSync(true, fd, buffers, position), 'write');
        },
        stat(path, bigint, unused, throwIfNoEntry) {
            return result(platform.native.fsStatSync(path, true, bigint), 'stat', path, throwIfNoEntry);
        },
        lstat(path, bigint, unused, throwIfNoEntry) {
            return result(platform.native.fsStatSync(path, false, bigint), 'lstat', path, throwIfNoEntry);
        },
        fstat(fd, bigint) {
            validateInt32(fd, 'fd', 0);
            return result(platform.native.fsStatSync(fd, true, bigint), 'fstat');
        },
        fchmod(fd, mode) { return control('fchmod', fd, mode); },
        fchown(fd, uid, gid) { return control('fchown', fd, uid, gid); },
        futimes(fd, atime, mtime) { return control('futimes', fd, atime, mtime); },
        fsync(fd) { return control('fsync', fd); },
        fdatasync(fd) { return control('fdatasync', fd); },
    };
    /* NODE_FS_SHARED_UTILITIES */
    function fromNative(value, syscall, path, throwIfNoEntry = true) {
        if (typeof value === 'number' && value < 0) {
            if (!throwIfNoEntry && (value === -2 || value === -20)) return undefined;
            platform.throwErrno(-value, syscall, path);
        }
        return getStatsFromBinding(value);
    }
    return { Stats, BigIntStats, getStatsFromBinding, fromNative,
        openSync, readSync, writeSync, readvSync, writevSync,
        statSync, lstatSync, fstatSync, fchmodSync, fchownSync, futimesSync, fsyncSync, fdatasyncSync,
        getOptions, copyObject, validatePath, getValidatedPath, getValidatedFd, stringToFlags, toUnixTimestamp,
        validateOffsetLengthRead, validateOffsetLengthWrite, validatePosition,
        validateBufferArray, validateStringAfterArrayBufferView,
        validateReadFileBufferOptions, getReadFileBuffer, getReadFileBufferByteLengthName, createReadFileBufferTooSmallError,
        constants: { kIoMaxLength, kMaxUserId, kReadFileBufferLength,
            kReadFileUnknownBufferLength, kWriteFileMaxChunkSize },
        publicStats: platform.values.util.deprecate(Stats,
            'fs.Stats constructor is deprecated.', 'DEP0180') };
}
