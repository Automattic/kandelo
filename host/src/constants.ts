/** WebAssembly page size (64 KiB) */
export const WASM_PAGE_SIZE = 65536;

/** Channel header size in bytes (6 x i64 args = 48B, i64 return = 8B, i32 errno + pad = 8B) */
export const CH_HEADER_SIZE = 72;

/** Channel data buffer size */
export const CH_DATA_SIZE = 65536;

/** Total channel size: header + data */
export const CH_TOTAL_SIZE = CH_HEADER_SIZE + CH_DATA_SIZE;

/** Default max pages for WebAssembly.Memory */
export const DEFAULT_MAX_PAGES = 16384;

/**
 * Pages allocated per thread: 2 for channel (65,608 bytes spills past one
 * 64 KiB page), 1 gap page, 1 for TLS.
 */
export const PAGES_PER_THREAD = 4;
