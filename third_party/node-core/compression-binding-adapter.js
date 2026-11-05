// Private Node binding constructors own actual engine codec handles. The pinned
// public/iterator algorithms supply validation, buffering and processing loops.
function _createNodeCompressionBinding(platform) {
    'use strict';
    const { TypeError, RangeError } = _createNodePrimordials();
    const constants = platform.compressionConstants;
    function construct(constructor, target, mode) {
        if (target === undefined) throw new TypeError('Compression handle requires new');
        const value = target.prototype;
        const prototype = value !== null && (typeof value === 'object' || typeof value === 'function') ? value : constructor.prototype;
        return platform.native.createCompressionHandle(mode, prototype);
    }
    function Zlib(mode) {
        if (typeof mode !== 'number' || mode < constants.DEFLATE || mode > constants.UNZIP || (mode | 0) !== mode) {
            throw new RangeError('Invalid zlib handle mode');
        }
        return construct(Zlib, new.target, mode);
    }
    function BrotliEncoder(mode) {
        if (mode !== constants.BROTLI_ENCODE) throw new RangeError('Invalid Brotli encoder mode');
        return construct(BrotliEncoder, new.target, mode);
    }
    function BrotliDecoder(mode) {
        if (mode !== constants.BROTLI_DECODE) throw new RangeError('Invalid Brotli decoder mode');
        return construct(BrotliDecoder, new.target, mode);
    }
    function ZstdCompress() { return construct(ZstdCompress, new.target, constants.ZSTD_COMPRESS); }
    function ZstdDecompress() { return construct(ZstdDecompress, new.target, constants.ZSTD_DECOMPRESS); }
    return { Zlib, BrotliEncoder, BrotliDecoder, ZstdCompress, ZstdDecompress,
        crc32: (data, value) => platform.native.crc32(data, value) };
}
