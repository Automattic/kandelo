// Borrowed stdio mode ownership. This is not a public Socket/TTY constructor.
function _createNodeTerminalPlatform(platform) {
    'use strict';
    const { SafeWeakMap, ObjectAssign, ReflectApply, Uint8Array } = _createNodePrimordials();
    const { ErrnoException, codes: { ERR_INVALID_ARG_VALUE, ERR_TTY_INIT_FAILED } } = platform.values.errors;
    const entries = new SafeWeakMap();
    const outputOwners = new SafeWeakMap();
    const { getColorDepth, hasColors } = platform.values.require('internal/tty');
    // Reopened writes and size queries share the same captured native owner.
    // Unsupported borrowed transports retain their explicit raw-fd fallback.
    function getWindowSize(output, result) {
        const binding = outputOwners.get(output);
        if (binding === undefined) throw new platform.values.errors.codes.ERR_INVALID_THIS('TTY output');
        const packet = binding.owner === undefined
            ? platform.native.operatingSystem('tty-size', binding.fd)
            : platform.native.operatingSystem('tty-output-size', binding.owner);
        if (packet.error) return packet.error;
        result[0] = packet.value[0];result[1] = packet.value[1];return 0;
    }
    let readline;
    function require(name) {
        if (name === 'readline') return platform.getReadline();
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Terminal dependency ' + name);
    }
    function WriteStream() {}
    /* NODE_TERMINAL_OUTPUT_METHODS */
    function bindOutput(output, fd) {
        // Pipes/files keep their actual fd stream and never acquire TTY fields.
        if (!outputOwners.has(output)) {
            if (!platform.isTTY(fd)) return false;
            outputOwners.set(output, { fd });
        }
        ObjectAssign(output, WriteStream.prototype);
        const dimensions = [0, 0];
        if (!getWindowSize(output, dimensions)) {
            output.columns = dimensions[0];output.rows = dimensions[1];
        }
        return true;
    }
    function openOutput(fd) {
        if (!platform.isTTY(fd)) return null;
        const packet = platform.native.operatingSystem('tty-output-open', fd);
        if (packet.error) {
            const code = platform.uv.getSystemErrorName(packet.error);
            // Unsupported reopen/alias paths retain the real borrowed async
            // transport. Their blocking/HWM mismatch remains an explicit gap.
            if (code === 'ENOTSUP' || code === 'EOPNOTSUPP') return null;
            throw new ERR_TTY_INIT_FAILED({ errno: packet.error, code,
                message: platform.uv.getSystemErrorMessage(packet.error), syscall: 'uv_tty_init' });
        }
        const owner = packet.value;
        const { streamBaseState, kBytesWritten, kLastWriteErr } = platform.streamBinding;
        try { owner.configureWrite(streamBaseState); }
        catch (error) { try { owner.close(); } catch (_) {} throw error; }
        function dispatched(ret, buffer, operation) {
            if (typeof ret === 'number') return ret ? new ErrnoException(ret, 'write') : undefined;
            const error = streamBaseState[kLastWriteErr];
            if (error) return new ErrnoException(error, 'write', ret.error);
            operation.published = true;
            // Real queued native WRITEWRAP. Keep the actual Writable callback
            // identity; this stdio consumer owns no Socket timer/_handle.
            ret.handle = owner;
            ret.oncomplete = function(status) {
                if (operation.settled) return;
                operation.settled = true;operation.entered = true;
                if (typeof this.callback === 'function')
                    this.callback(status < 0 ? new ErrnoException(status, 'write', this.error) : null);
            };
            ret.callback = operation.callback;
            ret.async = true;ret.bytes = streamBaseState[kBytesWritten];ret.buffer = buffer;
            const status = ret.writeStatus;
            if (status !== null) { ret.writeStatus = null;ret.oncomplete(status); }
            return true;
        }
        return {
            // Bind by output object, never by a public descriptor number that
            // can be closed/reused after native initialization.
            bind(output) { outputOwners.set(output, { owner }); },
            // Failed publication retires the actual captured descriptor through
            // its native queued-close owner, never the borrowed public fd.
            close() { return platform.native.operatingSystem('tty-output-close', owner); },
            write(chunk, operation) {
                return dispatched(owner.writeBuffer(null, chunk), chunk, operation);
            },
            writev(chunks, operation) {
                return dispatched(owner.writeVector(chunks), chunks, operation);
            },
        };
    }
    function openInput(fd) {
        if (!platform.isTTY(fd)) return null;
        const packet = platform.native.operatingSystem('tty-input-open', fd);
        if (packet.error) {
            const code = platform.uv.getSystemErrorName(packet.error);
            // Preserve existing master/unreopenable fallback as an explicit gap.
            if (code === 'ENOTSUP' || code === 'EOPNOTSUPP') return null;
            throw new ERR_TTY_INIT_FAILED({ errno: packet.error, code,
                message: platform.uv.getSystemErrorMessage(packet.error), syscall: 'uv_tty_init' });
        }
        const owner = packet.value;
        const { streamBaseState, kReadBytesOrError, kArrayBufferOffset } = platform.streamBinding;
        // This is the real shared pinned stream-state binding also consumed
        // by native TCP. It is not a TTY-shaped handle or synthetic metadata.
        try {
            owner.configureRead(function(_status, buffer, onread) {
                return ReflectApply(onread, this, [buffer]);
            }, streamBaseState);
        } catch (error) {
            try { owner.close(); } catch (_) {}
            throw error;
        }
        return {
            bind(input) { entries.set(input, owner); },
            // Native readStart is continuous. The borrowed fd-readable consumer
            // requests one completion at a time, so stop real native demand
            // before invoking it; Readable alone decides whether to rearm.
            start(_length, callback) {
                owner.onread = function(buffer) {
                    const count = streamBaseState[kReadBytesOrError];
                    const offset = streamBaseState[kArrayBufferOffset];
                    owner.readStop();
                    if (count > 0) callback(0, new Uint8Array(buffer, offset, count));
                    else if (count === -4095) callback(0, new Uint8Array(0));
                    else callback(count);
                };
                const status = owner.readStart();
                return status ? new ErrnoException(status, 'read') : undefined;
            },
            stop() { return platform.native.operatingSystem('tty-input-stop', owner); },
            error(status) { return new ErrnoException(status, 'read'); },
            ref(value) { if (value) owner.ref();else owner.unref(); },
            read(length) { return platform.native.operatingSystem('tty-input-read', owner, length); },
            control(promise, value) { return platform.native.operatingSystem('tty-input-control', owner, promise, value).value; },
            close() { owner.close(); },
        };
    }
    // Exact pinned uv_tty_mode_t values, not capability or terminal-state data.
    const UV_TTY_MODE_NORMAL = 0, UV_TTY_MODE_IO = 2, UV_TTY_MODE_RAW_VT = 3;
    function setMode(input, mode) {
        const owner = entries.get(input);
        // Match the target optional-handle path after close or when borrowed.
        if (owner === undefined) return undefined;
        return platform.native.operatingSystem('tty-mode', owner, mode).error;
    }
    function ReadStream() {}
    /* NODE_TERMINAL_SET_RAW */
    function bindInput(input, fd) {
        const packet = entries.has(input) ? { error: 0, value: entries.get(input) } :
            platform.native.operatingSystem('tty-open', fd);
        if (packet.error) throw new ERR_TTY_INIT_FAILED({
            errno: packet.error, code: platform.uv.getSystemErrorName(packet.error),
            message: platform.uv.getSystemErrorMessage(packet.error), syscall: 'uv_tty_init',
        });
        entries.set(input, packet.value);
        input.isRaw = false;input.rawMode = false;
        input.setRawMode = ReadStream.prototype.setRawMode;
        return function retireInputMode() {
            const owner = entries.get(input);entries.delete(input);
            if (owner !== undefined) platform.native.operatingSystem('tty-close', owner);
        };
    }
    function refreshOutput(output) {
        // Actual binding identity, not the mutable public isTTY convenience flag.
        if (outputOwners.has(output)) output._refreshSize();
    }
    return { bindInput, bindOutput, refreshOutput, openOutput, openInput };
}
