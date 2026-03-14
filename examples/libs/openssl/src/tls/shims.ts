/**
 * Shims for @php-wasm/util and @php-wasm/logger functions used by the
 * vendored WordPress Playground TLS 1.2 library.
 *
 * Original source: https://github.com/WordPress/wordpress-playground
 * License: GPL-2.0-or-later (see NOTICE file in this directory)
 */

export function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
	let totalLength = 0;
	arrays.forEach((a) => (totalLength += a.length));
	const result = new Uint8Array(totalLength);
	let offset = 0;
	arrays.forEach((a) => {
		result.set(a, offset);
		offset += a.length;
	});
	return result;
}

export function concatArrayBuffers(
	buffers: (ArrayBuffer | ArrayBufferLike | ArrayBufferView)[]
): ArrayBuffer {
	return concatUint8Arrays(
		buffers.map((b) => {
			if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength);
			return new Uint8Array(b as ArrayBuffer);
		})
	).buffer as ArrayBuffer;
}

export const logger = {
	warn: (...args: unknown[]) => console.warn(...args),
	error: (...args: unknown[]) => console.error(...args),
	info: (...args: unknown[]) => console.info(...args),
	debug: (...args: unknown[]) => console.debug(...args),
	log: (...args: unknown[]) => console.log(...args),
};
