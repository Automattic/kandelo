// Standalone public settings/protocol data; no native sessions are fabricated.
function _createNodeHttp2Settings(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayIsArray, Number, NumberIsNaN, ObjectEntries, ObjectDefineProperty,
        ReflectApply, Symbol, Uint32Array } = primordials;
    const { hideStackFrames, codes: { ERR_INVALID_ARG_TYPE,
        ERR_HTTP2_INVALID_SETTING_VALUE, ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS,
        ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH } } = platform.values.errors;
    const process = platform.process;
    const isArrayBufferView = platform.types.isArrayBufferView;
    // Use the existing pinned numeric owners without public method lookups at
    // call time. In particular Uint16Array input retains upstream element
    // interpretation; it is not silently copied/reinterpreted as raw bytes.
    const read16 = platform.Buffer.prototype.readUInt16BE;
    const read32 = platform.Buffer.prototype.readUInt32BE;
    const write16 = platform.Buffer.prototype.writeUInt16BE;
    const write32 = platform.Buffer.prototype.writeUInt32BE;
    const readUInt16BE = (buf, offset) => ReflectApply(read16, buf, [offset]);
    const readUInt32BE = (buf, offset) => ReflectApply(read32, buf, [offset]);
    const allocate = platform.allocator.createUnsafeBuffer;
    const constants = {};
    for (const [name, value, enumerable] of /* NODE_HTTP2_CONSTANTS */)
        ObjectDefineProperty(constants, name, { __proto__: null, value, enumerable });
    const { NGHTTP2_SETTINGS_HEADER_TABLE_SIZE, NGHTTP2_SETTINGS_ENABLE_PUSH,
        NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS, NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE,
        NGHTTP2_SETTINGS_MAX_FRAME_SIZE, NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE,
        NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL } = constants;
    /* NODE_HTTP2_BOUNDS */
    const kEmptyObject = platform.values.util.kEmptyObject;
    const kSensitiveHeaders = Symbol('sensitiveHeaders');
    /* NODE_HTTP2_LAYOUT */
    // This is the actual private settings owner for these synchronous helpers,
    // with the same Uint32 coercion/layout as Node's binding. It is neither a
    // session's local/remote settings nor an invented stream capability.
    const settingsBuffer = new Uint32Array(IDX_SETTINGS_FLAGS + 2 + MAX_ADDITIONAL_SETTINGS * 2);
    const binding = {
        refreshDefaultSettings() {
            let flags = 0;
            /* NODE_HTTP2_DEFAULTS */
            settingsBuffer[IDX_SETTINGS_FLAGS] = flags;
            settingsBuffer[IDX_SETTINGS_FLAGS + 1] = 0;
        },
        packSettings() {
            // Http2Settings::Init captures actual entries before Buffer
            // allocation. Reentry during allocation must not reread the owner.
            const entries = new Uint32Array((IDX_SETTINGS_FLAGS + MAX_ADDITIONAL_SETTINGS) * 2);
            const flags = settingsBuffer[IDX_SETTINGS_FLAGS];
            let count = 0;
            /* NODE_HTTP2_ORDER */
            const additional = settingsBuffer[IDX_SETTINGS_FLAGS + 1];
            for (let i = 0; i < additional; i++) {
                entries[count * 2] = settingsBuffer[IDX_SETTINGS_FLAGS + 2 + i * 2];
                entries[count * 2 + 1] = settingsBuffer[IDX_SETTINGS_FLAGS + 3 + i * 2];
                count++;
            }
            // nghttp2_pack_settings_payload returns failure for an invalid
            // known setting; Node exposes undefined, not a manufactured frame.
            const bytes = allocate(count * 6);
            for (let i = 0; i < count; i++) {
                const id = entries[i * 2], value = entries[i * 2 + 1];
                if (!validEntry(id, value)) return undefined;
            }
            for (let i = 0; i < count; i++) {
                ReflectApply(write16, bytes, [entries[i * 2] & 0xffff, i * 6]);
                ReflectApply(write32, bytes, [entries[i * 2 + 1], i * 6 + 2]);
            }
            return bytes;
        },
    };
    function validEntry(id, value) {
        /* NODE_HTTP2_WIRE_VALIDATION */
        return true;
    }
    /* NODE_HTTP2_ASSERTOBJECT */
    /* NODE_HTTP2_ASSERTRANGE */
    /* NODE_HTTP2_DEFAULTS_FUNCTIONS */
    /* NODE_HTTP2_UPDATE */
    /* NODE_HTTP2_VALIDATE */
    /* NODE_HTTP2_PUBLIC */
    return { constants, getDefaultSettings, getPackedSettings, getUnpackedSettings,
        sensitiveHeaders: kSensitiveHeaders };
}
