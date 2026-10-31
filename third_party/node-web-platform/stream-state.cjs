// Fetch's bodyUsed algorithm needs the stream's internal disturbance state.
// This is an embedding boundary for the pinned ponyfill, not a public Web API.
// The ponyfill itself owns and updates these slots on reads/cancellation/pipes.
const { ReadableStream, ReadableByteStreamController } = require('web-streams-polyfill');
const call = Function.prototype.call.bind(Function.prototype.call);
const descriptor = Object.getOwnPropertyDescriptor;
const lockedGetter = descriptor(ReadableStream.prototype, 'locked').get;
const byteSizeGetter = descriptor(ReadableByteStreamController.prototype, 'desiredSize').get;
function isReadable(value) {
    try { call(lockedGetter, value); return true; } catch (_) { return false; }
}
function isLocked(value) { return call(lockedGetter, value); }
function isDisturbed(value) {
    call(lockedGetter, value); // Use the implementation's own brand check.
    const state = descriptor(value, '_disturbed');
    if (!state || typeof state.value !== 'boolean') {
        throw new TypeError('Unsupported readable stream disturbance layout');
    }
    return state.value;
}
function isByteStream(value) {
    call(lockedGetter, value);
    try { call(byteSizeGetter, value._readableStreamController); return true; }
    catch (_) { return false; }
}
module.exports = { isReadable, isLocked, isDisturbed, isByteStream };
