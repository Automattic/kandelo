// Pinned OS frontend with real POSIX operation/byte owners. Missing measured
// capabilities fail explicitly, never returning CPU/memory/interface presets.
function _createNodeOSPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { NumberParseInt, StringPrototypeIncludes, StringPrototypeIndexOf, StringPrototypeSlice, StringPrototypeToLowerCase,
        ObjectCreate, ObjectDefineProperties, ObjectGetOwnPropertyDescriptors } = primordials;
    const process = platform.process;
    const { codecs } = platform;
    const { normalizeEncoding } = platform.values.util;
    const { ERR_SYSTEM_ERROR, ERR_METHOD_NOT_IMPLEMENTED } = platform.values.errors.codes;
    /* NODE_OS_CIDR */
    function unsupported(name) { throw new ERR_METHOD_NOT_IMPLEMENTED('os.' + name + ' measurement/backend'); }
    function result(operation, context, syscall, first, second) {
        const record = platform.native.operatingSystem(operation, first, second);
        if (record.error === 0) return record.value;
        const info = { errno: record.error, code: platform.uv.getSystemErrorName(record.error),
            message: platform.uv.getSystemErrorMessage(record.error), syscall };
        if (!context) throw new ERR_SYSTEM_ERROR(info);
        primordials.ObjectAssign(context, info);
        return undefined;
    }
    function text(bytes) { return codecs.decodeBytes(bytes, 'utf8'); }
    const binding = {
        getOSInformation() {
            const fields = result('info', undefined, 'uv_os_uname');
            return [text(fields[0]),text(fields[1]),text(fields[2]),text(fields[3])];
        },
        getHomeDirectory(context) { const value = result('home',context,'uv_os_homedir'); return value === undefined ? value : text(value); },
        getHostname(context) { const value = result('hostname',context,'uv_os_gethostname'); return value === undefined ? value : text(value); },
        getUserInfo(options, context) {
            // Native ParseEncoding only consumes actual string encodings and
            // falls back to UTF-8 for unknown names; getter failures propagate.
            let encoding = options?.encoding;
            if (typeof encoding === 'string') {
                const nul = StringPrototypeIndexOf(encoding, '\0');
                if (nul !== -1) encoding = StringPrototypeSlice(encoding, 0, nul);
                encoding = StringPrototypeToLowerCase(encoding);
            }
            if (typeof encoding !== 'string') encoding = 'utf8';
            else if (encoding !== 'buffer') encoding = normalizeEncoding(encoding) || 'utf8';
            const value = result('user',context,'uv_os_get_passwd');
            if (value === undefined) return undefined;
            const convert = bytes => encoding === 'buffer' ? codecs.copyBytes(bytes) : codecs.decodeBytes(bytes, encoding);
            return ObjectCreate(null, {
                uid: { value:value.uid, writable:true,enumerable:true,configurable:true },
                gid: { value:value.gid, writable:true,enumerable:true,configurable:true },
                username: { value:convert(value.username),writable:true,enumerable:true,configurable:true },
                homedir: { value:convert(value.homedir),writable:true,enumerable:true,configurable:true },
                shell: { value:value.shell === null ? null : convert(value.shell),writable:true,enumerable:true,configurable:true },
            });
        },
        getPriority(pid,context) { return result('getpriority',context,'uv_os_getpriority',pid); },
        setPriority(pid,priority,context) {
            const record = platform.native.operatingSystem('setpriority',pid,priority);
            if (record.error !== 0) primordials.ObjectAssign(context, { errno:record.error,
                code:platform.uv.getSystemErrorName(record.error),message:platform.uv.getSystemErrorMessage(record.error),syscall:'uv_os_setpriority' });
            return record.error;
        },
        getAvailableParallelism() { return unsupported('availableParallelism'); },
        getCPUs() { return unsupported('cpus'); },
        getFreeMem() { return unsupported('freemem'); },
        getTotalMem() { return unsupported('totalmem'); },
        getLoadAvg() { return unsupported('loadavg'); },
        getInterfaceAddresses() { return unsupported('networkInterfaces'); },
        getUptime() { return unsupported('uptime'); },
        isBigEndian: result('endianness',undefined,'endianness'),
    };
    function internalBinding(name) {
        if (name === 'os') return binding;
        if (name === 'constants') return { os:platform.constants };
        if (name === 'credentials') return { getTempDir() {
            const bytes = result('temp',undefined,'safe_getenv'); return bytes === undefined ? bytes : text(bytes);
        } };
        throw new primordials.Error('Unsupported OS binding: ' + name);
    }
    function require(name) {
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/util') return { getCIDR };
        throw new primordials.Error('Unsupported OS dependency: ' + name);
    }
    const module = { exports:{} };
    (function(module,exports,require,primordials,internalBinding,process) {
        /* NODE_OS_MODULE */
    })(module,module.exports,require,primordials,internalBinding,process);
    return { api:module.exports, install(target) {
        ObjectDefineProperties(target,ObjectGetOwnPropertyDescriptors(module.exports));
        return target;
    } };
}
