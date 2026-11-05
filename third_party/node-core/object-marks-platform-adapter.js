// Unchanged public marking guards, with real engine-private object state.
function _createNodeObjectMarks(platform) {
    'use strict';
    const isArrayBuffer = platform.isArrayBuffer;
    const kDetachKey = _createNodePrimordials().Symbol('detach_key_for_untransferable_arraybuffer');
    const setDetachKey = object => platform.native.markBufferUntransferable(object);
    /* NODE_OBJECT_TRANSFER_MARKS */
    return { markAsUntransferable, isMarkedAsUntransferable };
}
