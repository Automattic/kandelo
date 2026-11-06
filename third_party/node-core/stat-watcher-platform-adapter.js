// Pinned public watchFile/StatWatcher algorithms over the actual native owner.
function _createNodeStatWatcherPlatform(platform) {
    'use strict';
    const P = _createNodePrimordials();
    const { FunctionPrototypeCall, ObjectSetPrototypeOf, SafeMap, Symbol } = P;
    const { validateFunction, validateUint32 } = platform.values.validators;
    const { UVException } = platform.values.errors;
    const { getValidatedPath, getStatsFromBinding } = platform.utils;
    const { defaultTriggerAsyncIdScope, symbols: { owner_symbol } } = platform.async;
    const EventEmitter = platform.events.EventEmitter;
    const process = platform.process;
    const pathModule = platform.path;
    const toNamespacedPath = platform.path.toNamespacedPath;
    const vfsState = platform.truncation.vfsState;
    const kFsStatsFieldsNumber = 18;
    const native = (...args) => P.ReflectApply(platform.native.statWatcher, undefined, args);
    const _StatWatcher = class StatWatcher {
        constructor(bigint) { return native('create', new.target.prototype, bigint); }
        start(filename, interval) { return native('start', this, filename, interval); }
        close(callback) { return native('close', this, callback); }
        ref() { return native('ref', this); }
        unref() { return native('unref', this); }
        hasRef() { return native('hasRef', this); }
        getAsyncId() { return native('getAsyncId', this); }
    };
    /* NODE_STAT_WATCHER_SYMBOLS */
    /* NODE_STAT_WATCHER_PUBLIC */
    const watchers = { StatWatcher, kFSStatWatcherStart, kFSStatWatcherAddOrCleanRef };
    const require = name => {
        if (name === 'internal/fs/watchers') return watchers;
        throw new P.Error('Unresolved stat watcher dependency: ' + name);
    };
    /* NODE_FS_WATCH_FILE */
    return { watchFile, unwatchFile, watchers };
}
