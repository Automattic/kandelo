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

/**
 * Return `source` as a view guaranteed to be backed by an `ArrayBuffer`,
 * copying only when it is not already.
 *
 * Web Crypto and `fetch` reject `SharedArrayBuffer`-backed views: the
 * `BufferSource` type is `ArrayBufferView<ArrayBuffer> | ArrayBuffer`, and
 * every engine this platform targets throws rather than reading one. That was
 * measured on Node 24.15.0, Chromium 151 and WebKit 26.5.
 *
 * It matters here because Kandelo hands this library bytes that came straight
 * out of guest process memory, and guest process memory IS a
 * `SharedArrayBuffer`. Passing such a view to `crypto.subtle` is a runtime
 * fault, not a typing inconvenience, so the copy belongs at this boundary
 * rather than at a cast.
 */
export function toCryptoBufferSource(
	source: ArrayBuffer | ArrayBufferLike | ArrayBufferView
): Uint8Array<ArrayBuffer> {
	const view = ArrayBuffer.isView(source)
		? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
		: new Uint8Array(source as ArrayBuffer);
	return (
		view.buffer instanceof ArrayBuffer ? view : new Uint8Array(view)
	) as Uint8Array<ArrayBuffer>;
}

export const logger = {
	warn: (...args: unknown[]) => console.warn(...args),
	error: (...args: unknown[]) => console.error(...args),
	info: (...args: unknown[]) => console.info(...args),
	debug: (...args: unknown[]) => console.debug(...args),
	log: (...args: unknown[]) => console.log(...args),
};
