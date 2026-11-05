// Pinned directory APIs/classes over actual native byte scans and work owners.
function _createNodeReaddirPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayBuffer, ArrayPrototypePush, ErrorCaptureStackTrace, Promise,
        PromisePrototypeThen, PromiseReject, ReflectApply, ReflectOwnKeys,
        Symbol, Uint8Array, Uint32Array, TypedArrayPrototypeSet } = primordials;
    const { codes: { ERR_INVALID_ARG_TYPE } } = platform.values.errors;
    const { validateBoolean, validateFunction } = platform.values.validators;
    const { once } = platform.values.util;
    const { getOptions, getValidatedPath, copyObject } = platform.utils;
    const { makeError, FSReqCallback, vfsState } = platform.truncation;
    const { Buffer, path: pathModule, process } = platform;
    const { isUint8Array } = platform.types;
    const isWindows = process.platform === 'win32';
    const permission = { isEnabled: () => platform.permissionEnabled() };
    const CHAR_FORWARD_SLASH = 0x2F, CHAR_BACKWARD_SLASH = 0x5C;
    const kType = Symbol('type'), kStats = Symbol('stats');
    const kUsePromises = Symbol('readdir_use_promises');
    const lazyLoadFs = () => platform.fs;
    const { /* NODE_DIRENT_ENUM_NAMES */ } = { /* NODE_DIRENT_ENUM_VALUES */ };
    function marshal(packet, encoding, recursive, withTypes) {
        if (typeof packet[0] === 'number')
            throw makeError(packet[0], 'scandir', platform.codecs.decodeBytes(packet[1]));
        const rawNames = packet[0], rawTypes = packet[1], rawCounts = packet[2], rawDirectories = packet[3];
        // The native arrays already have own writable slots. Reuse them so
        // private encoding does not consult inherited Array index setters.
        const names = rawNames;
        for (let i = 0; i < names.length; i++) names[i] =
            encoding === 'buffer' ? platform.codecs.copyBytes(names[i]) : platform.codecs.decodeBytes(names[i], encoding);
        if (!withTypes) return names;
        if (!recursive) return [names, rawTypes];
        const offset = rawTypes.length + (4 - rawTypes.length % 4) % 4;
        const buffer = new ArrayBuffer(offset + rawCounts.length * 4);
        const types = new Uint8Array(buffer, 0, rawTypes.length);
        const counts = new Uint32Array(buffer, offset, rawCounts.length);
        TypedArrayPrototypeSet(types, rawTypes);
        TypedArrayPrototypeSet(counts, rawCounts);
        const directories = rawDirectories;
        for (let i = 0; i < directories.length; i++) directories[i] =
            encoding === 'buffer' ? platform.codecs.copyBytes(directories[i]) : platform.codecs.decodeBytes(directories[i], encoding);
        return [names, types, counts, directories];
    }
    function read(path, encoding, withTypes, request, recursive) {
        const convert = packet => marshal(packet, encoding, recursive, withTypes);
        if (request === undefined)
            return platform.native.fsReaddirSync(path, recursive, withTypes, convert);
        return platform.native.fsReaddirPromise(path, recursive, withTypes,
            request === kUsePromises ? makeError : request, convert);
    }
    const binding = {
        readdir: (path, encoding, withTypes, request) => read(path, encoding, withTypes, request, false),
        readdirRecursive: (path, encoding, withTypes, request) => read(path, encoding, withTypes, request, true),
        internalModuleStat: path => platform.internalModuleStat(path),
    };
    /* NODE_READDIR_UTILS */
    const getDirectoryEntriesPromise = platform.promisify(getDirents);
    /* NODE_READDIR_SHARED */
    function callbackAPIs() {
        /* NODE_READDIR_PUBLIC */
        return { readdir, readdirSync, Dirent };
    }
    function promiseAPIs() {
        /* NODE_READDIR_PROMISE */
        return { readdir };
    }
    return { api: callbackAPIs(), promises: promiseAPIs(),
        utilities: { getDirent, getDirents, getRecursiveDirents } };
}
