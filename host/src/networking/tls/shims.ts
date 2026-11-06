/** Fetch and WebCrypto reject SharedArrayBuffer-backed views. Preserve a
 * private view's exact byte range; copy a shared range before crossing those
 * APIs. Casting the backing type would leave real shared views invalid, and
 * passing `.buffer` would include unrelated prefix/suffix bytes. */
export function nonSharedBytes(source: ArrayBufferLike | ArrayBufferView): Uint8Array<ArrayBuffer> {
	const view = ArrayBuffer.isView(source);
	const buffer = view ? source.buffer : source;
	const offset = view ? source.byteOffset : 0;
	const length = source.byteLength;
	return buffer instanceof ArrayBuffer
		? new Uint8Array(buffer, offset, length)
		: new Uint8Array(new Uint8Array(buffer, offset, length));
}

/**
 * Shims for @php-wasm/util and @php-wasm/logger functions used by the
 * vendored WordPress Playground TLS 1.2 library.
 *
 * Original source: https://github.com/WordPress/wordpress-playground
 * License: GPL-2.0-or-later (see NOTICE file in this directory)
 */

export function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
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
			if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
			return new Uint8Array(b);
		})
	).buffer;
}

export const logger = {
	warn: (...args: unknown[]) => console.warn(...args),
	error: (...args: unknown[]) => console.error(...args),
	info: (...args: unknown[]) => console.info(...args),
	debug: (...args: unknown[]) => console.debug(...args),
	log: (...args: unknown[]) => console.log(...args),
};
