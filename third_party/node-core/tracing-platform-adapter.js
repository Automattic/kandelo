// Actual native process category/sink owner. The pinned public wrapper supplies
// validation/descriptors/retention; native ownership remains shared by Workers.
function _createNodeTracingOwner(platform) {
    'use strict';
    const P = _createNodePrimordials();
    const { BigInt, BigIntAsUintN, BigIntPrototypeToString, JSONStringify, StringFromCharCode,
        StringPrototypeIndexOf, StringPrototypeSlice, TypeError, ReflectApply } = P;
    const operate = platform.native.operatingSystem;
    function call(operation, ...args) {
        const result = ReflectApply(operate, platform.native, [operation, ...args]);
        if (result.error) throw new platform.values.errors.codes.ERR_SYSTEM_ERROR({
            errno: result.error, code: platform.uv.getSystemErrorName(result.error),
            message: platform.uv.getSystemErrorMessage(result.error), syscall: operation,
        });
        return result.value;
    }
    function cstring(value) {
        const end = StringPrototypeIndexOf(value, '\0');
        return end === -1 ? value : StringPrototypeSlice(value, 0, end);
    }
    class CategorySet {
        #owner;
        constructor(categories) { this.#owner = call('trace-create', categories); }
        enable() { call('trace-enable', this.#owner); }
        disable() { call('trace-disable', this.#owner); }
    }
    return {
        CategorySet,
        hasAgent() { return call('trace-has-agent'); },
        getEnabledCategories() { return call('trace-categories'); },
        isTraceCategoryEnabled(category) {
            if (typeof category !== 'string') throw new TypeError('Trace event category must be a string.');
            return call('trace-enabled', cstring(category));
        },
        trace(phase, category, name, id, value) {
            if (typeof category !== 'string') throw new TypeError('Trace event category must be a string.');
            category = cstring(category);
            if (!call('trace-enabled', category)) return false;
            if (typeof phase !== 'number') throw new TypeError('Trace event phase must be a number.');
            if (typeof name !== 'string') throw new TypeError('Trace event name must be a string.');
            if (id !== undefined && id !== null && typeof id !== 'number') throw new TypeError('Trace event id must be a number.');
            if (name.length === 0) throw new TypeError('Trace event name must not be an empty string.');
            // The classic pinned writer takes already escaped event names.
            // Console time helpers perform safeTraceLabel before publishing.
            // Re-encoding those bytes as a JS JSON string would double escape
            // real labels and differ from the consumed upstream algorithm.
            let fields = '{"ph":"' + StringFromCharCode((phase | 0) & 255) +
                '","cat":"' + category + '","name":"' + cstring(name) + '"';
            if (id !== undefined && id !== null) {
                const number = BigInt(id | 0);
                fields += ',"id":"0x' + BigIntPrototypeToString(BigIntAsUintN(64, number), 16) + '"';
            }
            fields += ',"args":{';
            if (value !== undefined) fields += '"data":' + JSONStringify(value);
            fields += '}}';
            // Snapshot argument getters/JSON conversion before crossing the
            // native sink. No caller object or JS root enters shared state.
            call('trace-event', category, fields);
            return true;
        },
    };
}
