// Public process state stays on the guest libc/kernel path. Node's real
// wrapper algorithms are retained; environment properties are live views,
// not a seeded dictionary whose entries can disagree with native state.
function _createNodeProcessState(platform) {
    'use strict';
    const P = _createNodePrimordials();
    const { ObjectDefineProperty, ObjectEntries, ObjectPrototypeHasOwnProperty, SafeSet, TypeError } = P;
    const native = platform.native;
    function installVersions(process, targetVersion, engineVersion) {
        const versions = {
            node: targetVersion,
            spidermonkey: engineVersion,
            ...native.getCompressionVersions(),
            sqlite: native.sqlite('version'),
            ares: native.dnsVersion(),
            openssl: native.getOpenSSLVersion(),
        };
        // Node's metadata is read-only but configurable, including each entry.
        // Only report dependencies actually linked into this guest runtime.
        for (const [name, value] of ObjectEntries(versions)) {
            ObjectDefineProperty(versions, name, { value, writable: false,
                enumerable: true, configurable: true });
        }
        ObjectDefineProperty(process, 'versions', { value: versions, writable: false,
            enumerable: true, configurable: true });
        ObjectDefineProperty(process, 'version', { value: 'v' + targetVersion, writable: false,
            enumerable: true, configurable: true });
    }
    function descriptorError(accessor) {
        const error = new TypeError(accessor
            ? "'process.env' does not accept an accessor(getter/setter) descriptor"
            : "'process.env' only accepts a configurable, writable, and enumerable data descriptor");
        error.code = 'ERR_INVALID_OBJECT_DEFINE_PROPERTY';
        throw error;
    }
    function createEnvironment() {
        const get = key => typeof key === 'symbol' ? undefined : native.environment('get', key);
        const set = (key, value) => {
            // Abstract ToString rejects symbols, unlike String(symbol).
            const name = `${key}`;
            const text = `${value}`;
            // Node's RealEnvStore setter ignores failed POSIX environment names.
            native.environment('set', name, text);
            return true;
        };
        return native.createEnvironmentObject({
            get,
            set,
            keys() {
                return [...new SafeSet(native.environment('keys'))];
            },
            descriptor(key) {
                const value = get(key);
                if (value === undefined) return undefined;
                return { value, writable: true, enumerable: true, configurable: true };
            },
            define(key, descriptor) {
                if (ObjectPrototypeHasOwnProperty(descriptor, 'value')) {
                    // The native descriptor carrier has an ordinary prototype,
                    // but only its own fields represent native has_* flags.
                    // Do not let inherited properties invent omitted flags or
                    // run user getters before target descriptor rejection.
                    if (!ObjectPrototypeHasOwnProperty(descriptor, 'writable') ||
                        !ObjectPrototypeHasOwnProperty(descriptor, 'enumerable') ||
                        !ObjectPrototypeHasOwnProperty(descriptor, 'configurable') ||
                        !descriptor.configurable || !descriptor.enumerable || !descriptor.writable)
                        descriptorError(false);
                    return set(key, descriptor.value);
                }
                descriptorError(ObjectPrototypeHasOwnProperty(descriptor, 'get') ||
                    ObjectPrototypeHasOwnProperty(descriptor, 'set'));
            },
            remove(key) {
                if (typeof key !== 'symbol') native.environment('unset', key);
                return true;
            },
        }, P.ObjectPrototype);
    }

    function createAbort(ownsProcessState = true) {
        if (ownsProcessState) return native.processAbort;
        const { ERR_WORKER_UNSUPPORTED_OPERATION } = platform.getValues().errors.codes;
        // Unchanged pinned internal/process/worker_thread_only.js factory.
        function unavailable(name) {
          function unavailableInWorker() {
            throw new ERR_WORKER_UNSUPPORTED_OPERATION(name);
          }

          unavailableInWorker.disabled = true;
          return unavailableInWorker;
        }
        return unavailable('process.abort()');
    }

    function createUmask(ownsProcessState = true) {
        const rawMethods = { umask: mask => native.processUmask(mask) };
        if (ownsProcessState) {
            const parseFileMode = (...args) => platform.getValues().validators.parseFileMode(...args);
            /* NODE_UMASK_OWNER */
            return wrappedUmask;
        }
        const { ERR_WORKER_UNSUPPORTED_OPERATION } = platform.getValues().errors.codes;
        /* NODE_UMASK_WORKER */
        return wrappedUmask;
    }
    // Native completion throws the actual credential errno before publishing
    // the ordinary OS result packet; this synchronous getter has no async ID.
    const credentials = {
        getgroups() { return native.operatingSystem('process-getgroups').value; },
    };
    return { createEnvironment, createAbort, createUmask, installVersions,
        getgroups: credentials.getgroups,
        parentPid: () => native.processParentPid() };
}
