// One guest-realm registry for the public Node diagnostics algorithms and
// actual Kandelo JavaScript producers. Native C/C++ producers need their own
// bridge; their absence is not replaced with synthetic diagnostic events.
function _createNodeDiagnosticsPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const {
        ObjectCreate, ObjectDefineProperty, ObjectFreeze,
        SafeMap, SafeWeakRef, Uint32Array,
        TypedArrayPrototypeSet,
    } = primordials;
    const process = platform.process;
    const kEmptyObject = ObjectFreeze(ObjectCreate(null));
    /* NODE_DIAGNOSTICS_WEAK_REFERENCE */

    const records = new SafeMap();
    const indexed = [];
    let linkChannel;
    let subscribers = new Uint32Array(1024);
    function linked(record) {
        let channel = record.weak?.deref();
        if (channel === undefined) {
            channel = linkChannel(record.name, record.index);
            record.weak = new SafeWeakRef(channel);
            record.active = channel.hasSubscribers;
        }
        return channel;
    }
    const binding = {
        get subscribers() { return subscribers; },
        linkNativeChannel(callback) {
            platform.values.validators.validateFunction(callback, 'callback');
            linkChannel = callback;
            for (const record of indexed) {
                record.weak = undefined;
                linked(record);
            }
        },
        notifyChannelActive(index) {
            const record = indexed[index];
            if (record !== undefined) record.active = true;
        },
        notifyChannelInactive(index) {
            const record = indexed[index];
            if (record !== undefined) record.active = false;
        },
    };
    function require(name) {
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/util/types') return platform.types;
        if (name === 'internal/util') return { WeakReference, kEmptyObject };
        throw new primordials.Error('Unsupported diagnostics dependency: ' + name);
    }
    function internalBinding(name) {
        if (name === 'diagnostics_channel') return binding;
        if (name === 'errors') return {
            // The pinned module queues this through process.nextTick. Throw
            // in that owned callback so existing guest exception policy sees
            // the original value; never reject an unobserved helper Promise.
            triggerUncaughtException(error) { throw error; },
        };
        throw new primordials.Error('Unsupported diagnostics binding: ' + name);
    }
    const module = { exports: {} };
    (function(module, exports, require, primordials, internalBinding, process) {
        /* NODE_DIAGNOSTICS_MODULE */
    })(module, module.exports, require, primordials, internalBinding, process);
    function registerProducer(name) {
        platform.values.validators.validateString(name, 'name');
        let record = records.get(name);
        if (record === undefined) {
            const index = indexed.length;
            if (index === subscribers.length) {
                const grown = new Uint32Array(subscribers.length * 2);
                TypedArrayPrototypeSet(grown, subscribers);
                subscribers = grown;
            }
            record = { name, index, weak: undefined, active: false };
            records.set(name, record);
            indexed[index] = record;
            linked(record);
        }
        return ObjectFreeze({
            get hasSubscribers() {
                linked(record);
                return record.active && subscribers[record.index] > 0;
            },
            publish(data) {
                const channel = linked(record);
                if (record.active && subscribers[record.index] > 0) channel.publish(data);
            },
        });
    }
    return { api: module.exports, registerProducer };
}
