// Main-environment process stdio consumers over real captured output and
// process SignalWrap owners. This does not implement public TTY constructors.
function _createNodeStdioOutputPlatform(platform) {
    'use strict';
    const { ReflectApply } = _createNodePrimordials();
    const process = platform.process;
    const removeListener = process.removeListener;
    const stopListeningIfSignal = platform.signals.stopListeningIfSignal;
    let stdout, stderr;
    function refreshStdoutOnSigWinch() { platform.terminal.refreshOutput(stdout); }
    function refreshStderrOnSigWinch() { platform.terminal.refreshOutput(stderr); }
    function writable(fd) {
        if (fd === 1 && stdout) return stdout;
        if (fd === 2 && stderr) return stderr;
        return platform.fdStreams.writable(fd, undefined, output => {
            const refresh = fd === 1 ? refreshStdoutOnSigWinch : refreshStderrOnSigWinch;
            let registering = false;
            try {
                platform.terminal.bindOutput(output, fd);
                // The real start/init/newListener path can reenter process
                // stdio. Publish this owner first, like pinned process stdio.
                if (fd === 1) stdout = output;
                if (fd === 2) stderr = output;
                if (platform.mainEnvironment && output.isTTY) {
                    registering = true;
                    process.on('SIGWINCH', refresh);
                }
            } catch (error) {
                if (stdout === output) stdout = undefined;
                if (stderr === output) stderr = undefined;
                // A later newListener hook can throw after the genuine signal
                // start hook acquired its wrap but before listener insertion.
                // Remove only this consumer, then let the actual first/last
                // listener owner retire an otherwise empty subscription.
                if (registering) {
                    try { ReflectApply(removeListener, process, ['SIGWINCH', refresh]); } catch (_) {}
                    try { stopListeningIfSignal('SIGWINCH'); } catch (_) {}
                }
                // fdStreams' publication transaction closes the captured extra
                // owner and preserves this original exception, never fd1/2.
                throw error;
            }
        });
    }
    return { writable };
}
