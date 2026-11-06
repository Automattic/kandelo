// Native ownership is process-shared, while callbacks/promises below are
// context-local. The complete pinned public Lock/LockManager source owns all
// WebIDL, signal, diagnostic and observable public-object behavior.
function _createNodeLocksPlatform(platform) {
    'use strict';
    const P = _createNodePrimordials();
    const { ArrayPrototypePush, ObjectDefineProperty, Promise, PromisePrototypeThen, ReflectApply, SafeMap } = P;
    const requests = new SafeMap();
    const native = (...args) => ReflectApply(platform.native.locks, undefined, args);
    let publicModule;
    function settle(id, entry, rejected, value, processQueue = true) {
        const status = native('complete', id);
        requests.delete(id);
        // A stolen holder's released promise has already rejected. The user's
        // callback still owns its original lifetime and settles independently.
        if (status === 2 && !entry.stolen) {
            entry.stolen = true;
            entry.reject(new P.Error('LOCK_STOLEN'));
        } else if (!entry.stolen) {
            if (rejected) entry.reject(value); else entry.resolve(value);
        }
        if (processQueue) dispatchAll();
    }
    function stolen(id, entry, error) {
        entry.stolen = true;
        entry.reject(error);
        if (entry.callbackSettled) { native('complete', id); requests.delete(id); }
    }
    function dispatchOne() {
        if (!publicModule) return 0;
        let event, entry, victims, stolenError;
        // Prepare receiver-local roots/errors before the native state commit.
        // A GC/allocation failure or reentrant request cannot consume a steal
        // notification whose receiver has not acquired its actual JS packet.
        while (true) {
            event = native('next');
            if (event === undefined) return 0;
            entry = requests.get(event.id);
            if (!entry) throw new P.Error('Missing receiver-local Web Locks request');
            victims = [];
            stolenError = event.kind === 'stolen' ? new P.Error('LOCK_STOLEN') : undefined;
            for (let index = 0; index < event.localStolen.length; index++) {
                const id = event.localStolen[index];
                const victim = requests.get(id);
                if (!victim) throw new P.Error('Missing receiver-local stolen Web Locks request');
                ArrayPrototypePush(victims, { id, entry: victim, error: new P.Error('LOCK_STOLEN') });
            }
            if (native('commit', event.id)) break;
        }
        if (event.kind === 'stolen') {
            stolen(event.id, entry, stolenError);
            return 1;
        }
        for (let index = 0; index < victims.length; index++) {
            const victim = victims[index];
            stolen(victim.id, victim.entry, victim.error);
        }
        entry.started = true;
        let value;
        try { value = ReflectApply(entry.callback, undefined, [event.kind === 'miss' ? null : event.info]); }
        catch (error) {
            // Pinned native ProcessQueue rejects but retains the granted lock
            // on a synchronous throw. Retire releases it at context teardown.
            // This is an observed target behavior, not a compatibility repair.
            entry.waitReject(error);
            entry.reject(error);
            entry.callbackSettled = true;
            if (event.kind === 'miss') { native('complete', event.id); requests.delete(event.id); }
            return 2; // Pinned ProcessQueue ends this pass on a throw/miss.
        } finally { entry.callback = undefined; }
        // Match native IsPromise rather than assimilating thenables before
        // release. Promise resolution still assimilates the final result.
        if (platform.types.isPromise(value)) {
            try {
                PromisePrototypeThen(value,
                    result => settle(event.id, entry, false, result, event.kind !== 'miss'),
                    error => settle(event.id, entry, true, error, event.kind !== 'miss'));
            } catch (error) {
                entry.waitReject(error); entry.reject(error); entry.callbackSettled = true;
                if (event.kind === 'miss') { native('complete', event.id); requests.delete(event.id); }
                return 2;
            }
            entry.waitResolve(value);
        } else {
            // The target owns TWO actual internal promises. Resolving waiting
            // before release preserves thenable getters while the lock is held;
            // released resolves independently after the real registry release.
            entry.waitResolve(value);
            settle(event.id, entry, false, value, event.kind !== 'miss');
        }
        return event.kind === 'miss' ? 2 : 1;
    }
    function dispatchAll() {
        let count = 0;
        let progress;
        while ((progress = dispatchOne())) { count++; if (progress === 2) break; }
        return count;
    }
    const binding = {
        LOCK_MODE_SHARED: 'shared', LOCK_MODE_EXCLUSIVE: 'exclusive', LOCK_STOLEN_ERROR: 'LOCK_STOLEN',
        request(name, clientId, mode, steal, ifAvailable, callback) {
            let waitResolve, waitReject, resolve, reject;
            const waiting = new Promise((yes, no) => { waitResolve = yes; waitReject = no; });
            const released = new Promise((yes, no) => { resolve = yes; reject = no; });
            platform.native.markPromiseAsHandled(waiting);
            platform.native.markPromiseAsHandled(released);
            const id = native('request', name, clientId, mode, steal, ifAvailable);
            const entry = { callback, waitResolve, waitReject, resolve, reject,
                stolen: false, started: false, callbackSettled: false };
            try { requests.set(id, entry); }
            catch (error) { native('complete', id); throw error; }
            // Pinned Request calls ProcessQueue synchronously on this context.
            try { dispatchAll(); }
            catch (error) {
                native('discard');
                // The newly submitted callback has not run. Retire that exact
                // pending/undelivered owner; other prepared entries stay queued
                // and retryable, with their receiver-local roots intact.
                if (!entry.started) {
                    native('complete', id); requests.delete(id); entry.callback = undefined;
                    waitReject(error); reject(error);
                }
                throw error;
            }
            return released;
        },
        query() {
            let resolve;
            const result = new Promise(yes => { resolve = yes; });
            resolve(native('query'));
            return result;
        },
    };
    function load() {
        if (publicModule) return publicModule;
        const module = { exports: {} };
        function require(name) {
            if (name === 'internal/errors') return platform.values.errors;
            if (name === 'internal/util') return platform.values.util;
            if (name === 'internal/validators') return platform.values.validators;
            if (name === 'internal/worker') return platform.worker;
            if (name === 'internal/webidl') return platform.eventRequire(name);
            if (name === 'diagnostics_channel') return platform.diagnostics;
            throw new P.Error('Unsupported Web Locks dependency: ' + name);
        }
        function internalBinding(name) {
            if (name === 'locks') return binding;
            throw new P.Error('Unsupported Web Locks binding: ' + name);
        }
        (function(module, exports, require, primordials, internalBinding, process) {
            /* NODE_LOCKS_MODULE */
        })(module, module.exports, require, P, internalBinding, platform.process);
        publicModule = module.exports;
        return publicModule;
    }
    return {
        // One event per engine phase preserves the ordinary tick/job checkpoint.
        dispatch: dispatchOne,
        install(target) {
            ObjectDefineProperty(target, 'locks', {
                configurable: true, enumerable: true,
                get() {
                    const value = load().locks;
                    ObjectDefineProperty(target, 'locks', { value, writable: true, configurable: true, enumerable: true });
                    return value;
                },
                set(value) { ObjectDefineProperty(target, 'locks', { value, writable: true, configurable: true, enumerable: true }); },
            });
        },
    };
}
