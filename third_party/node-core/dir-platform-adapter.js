// Full pinned Dir queues/iteration/disposal over persistent native cursors.
function _createNodeDirPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { Buffer, process } = platform;
    const { makeError, FSReqCallback, vfsState } = platform.truncation;
    function marshal(packet, encoding) {
        if (typeof packet === 'number') throw makeError(packet, 'readdir');
        if (packet === null) return null;
        for (let i = 0; i < packet.length; i += 2)
            packet[i] = encoding === 'buffer' ? platform.codecs.copyBytes(packet[i]) :
                platform.codecs.decodeBytes(packet[i], encoding);
        return packet;
    }
    class DirHandle {
        read(encoding, bufferSize, request) {
            return platform.native.fsDirRead(this, bufferSize, request, packet => marshal(packet, encoding));
        }
        close(request) {
            const result = platform.native.fsDirClose(this, request);
            if (typeof result === 'number' && result < 0) throw makeError(result, 'closedir');
        }
    }
    function open(path, request, withPath = true) {
        const result = platform.native.fsDirOpen(path, DirHandle.prototype, request);
        if (typeof result === 'number') throw makeError(result, 'opendir', withPath ? path : undefined);
        return result;
    }
    const module = { exports: {} };
    const modules = {
        path: platform.path,
        'internal/errors': platform.values.errors,
        'internal/util': platform.values.util,
        'internal/validators': platform.values.validators,
        'internal/fs/utils': { ...platform.utils, ...platform.dirents, vfsState },
    };
    function require(name) {
        if (!primordials.ObjectPrototypeHasOwnProperty(modules, name))
            throw new primordials.Error('Unimplemented Dir dependency: ' + name);
        return modules[name];
    }
    function internalBinding(name) {
        if (name === 'fs') return { FSReqCallback };
        if (name === 'fs_dir') return {
            opendir: (path, _encoding, request) => open(path, request),
            opendirSync: path => open(path, undefined, false),
        };
        throw new primordials.Error('Unimplemented Dir binding: ' + name);
    }
    (function(module, exports, require, primordials, internalBinding, process) {
        /* NODE_DIR_MODULE */
    })(module, module.exports, require, primordials, internalBinding, process);
    return { api: module.exports, promises: { opendir: platform.values.util.promisify(module.exports.opendir) } };
}
