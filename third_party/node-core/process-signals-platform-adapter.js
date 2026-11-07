// Pinned process listener activation over a real main-environment SignalWrap.
function _createNodeProcessSignals(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const process = platform.process;
    const native = (...args) => primordials.ReflectApply(platform.native.signalOperation, undefined, args);
    const NativeSignal = class Signal {
        constructor() { return native('create', new.target.prototype); }
        start(signum) { return native('start', this, signum); }
        stop() { return native('stop', this); }
        close(callback) { return native('close', this, callback); }
        ref() { return native('ref', this); }
        unref() { return native('unref', this); }
        hasRef() { return native('hasRef', this); }
        getAsyncId() { return native('getAsyncId', this); }
    };
    const module = { exports: {} };
    const require = name => {
        if (name === 'internal/errors') return platform.values.errors;
        throw new primordials.Error('Unresolved process signal dependency: ' + name);
    };
    const internalBinding = name => {
        if (name === 'constants') return { os: { signals: platform.signals } };
        if (name === 'signal_wrap') return { Signal: NativeSignal };
        throw new primordials.Error('Unresolved process signal binding: ' + name);
    };
    /* NODE_PROCESS_SIGNALS */
    if (platform.native.workerEnvironment === null) {
        process.on('newListener', module.exports.startListeningIfSignal);
        process.on('removeListener', module.exports.stopListeningIfSignal);
    }
    return module.exports;
}
