// Pinned public whole-file algorithms over actual native descriptor I/O.
// UTF8 binding operations keep private bytes and fd ownership independent
// of mutable public fs/Buffer properties, as the target's native paths do.
function _createNodeFileSync(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayPrototypePush, MathMin, Number, ObjectSetPrototypeOf, TypedArrayPrototypeGetBuffer,
        TypedArrayPrototypeGetByteOffset, TypedArrayPrototypeGetByteLength,
        TypedArrayPrototypeSet, Uint8Array } = primordials;
    const { isInt32, validateBoolean, validateInt32, parseFileMode } = platform.values.validators;
    const { codes: { ERR_FS_FILE_TOO_LARGE, ERR_INVALID_ARG_VALUE } } = platform.values.errors;
    const { getOptions, copyObject, getValidatedPath, stringToFlags,
        validateReadFileBufferOptions, getReadFileBuffer, getReadFileBufferByteLengthName,
        constants: { kIoMaxLength } } = platform.utils;
    const { isArrayBufferView } = platform.types;
    const { validateStringAfterArrayBufferView } = platform.utils;
    const Buffer = platform.Buffer, fs = platform.fs;
    const { S_IFMT, S_IFREG } = fs.constants;
    const vfsState = platform.truncation.vfsState, isFd = isInt32;
    const native = platform.native;
    function result(value, syscall, path) {
        if (typeof value === 'number' && value < 0)
            throw platform.truncation.makeError(value, syscall, path);
        return value;
    }
    function closeOwned(fd) { result(native.closeDescriptor(fd), 'close'); }
    function io(writing, fd, bytes, offset, length) {
        return result(native.fsIoSync(writing, fd, bytes, offset, length, -1), writing ? 'write' : 'read');
    }
    const binding = {
        fstat(fd, bigint, unused, shouldNotThrow) {
            validateInt32(fd, 'fd', 0);
            const record = native.fsStatSync(fd, true, bigint);
            if (shouldNotThrow && typeof record === 'number' && record < 0) return undefined;
            return result(record, 'fstat');
        },
        readFileUtf8(path, flags) {
            const isUserFd = isInt32(path);
            const fd = isUserFd ? path : result(native.fsOpenSync(path, flags, 0o666), 'open', path);
            try {
                const chunks = ObjectSetPrototypeOf([], null);
                let length = 0;
                // Read until actual EOF, including unknown-size files/pipes.
                // Decode once so multibyte sequences survive read boundaries.
                while (true) {
                    const bytes = platform.allocator.createUnsafeBuffer(8192);
                    const count = io(false, fd, bytes, 0, 8192);
                    if (count === 0) break;
                    ArrayPrototypePush(chunks, new Uint8Array(TypedArrayPrototypeGetBuffer(bytes),
                        TypedArrayPrototypeGetByteOffset(bytes), count));
                    length += count;
                }
                const bytes = platform.allocator.createUnsafeBuffer(length);
                let offset = 0;
                for (let index = 0; index < chunks.length; index++) {
                    const chunk = chunks[index];
                    TypedArrayPrototypeSet(bytes, chunk, offset);
                    offset += TypedArrayPrototypeGetByteLength(chunk);
                }
                return platform.codecs.decodeBytes(bytes, 'utf8');
            } finally { if (!isUserFd) closeOwned(fd); }
        },
        writeFileUtf8(path, text, flags, mode) {
            const bytes = platform.codecs.encodeUtf8(text);
            const length = TypedArrayPrototypeGetByteLength(bytes);
            const isUserFd = isInt32(path);
            const fd = isUserFd ? path : result(native.fsOpenSync(path, flags, mode), 'open', path);
            try {
                let offset = 0;
                while (offset < length) offset += io(true, fd, bytes, offset, MathMin(length - offset, 0x7fffffff));
            } finally { if (!isUserFd) closeOwned(fd); }
        },
    };
    /* NODE_FS_WHOLE_SYNC */
    return { readFileSync, writeFileSync, appendFileSync };
}
