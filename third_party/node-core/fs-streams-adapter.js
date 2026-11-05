// Public fs stream factories/legacy aliases retain their distinct pinned
// lazy state. FileHandle streams independently load the same real constructors.
function _installNodeFileStreams(platform) {
    'use strict';
    const { ObjectDefineProperties, ObjectGetOwnPropertyDescriptors } = _createNodePrimordials();
    const vfsState = platform.truncation.vfsState;
    const require = platform.require;
    let ReadStream, WriteStream, FileReadStream, FileWriteStream;
    /* NODE_FS_STREAM_FACTORIES */
    const exports = { createReadStream, createWriteStream,
        /* NODE_FS_STREAM_ACCESSORS */
    };
    ObjectDefineProperties(platform.fs, ObjectGetOwnPropertyDescriptors(exports));
}
