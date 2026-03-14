/**
 * Type compatibility declarations for vendored WordPress Playground TLS code.
 *
 * TypeScript 5.7+ tightened the Uint8Array generic parameter, causing
 * Uint8Array<ArrayBufferLike> to not be assignable to BufferSource or
 * ArrayBuffer. This is a known issue with the DOM lib typings.
 *
 * These overrides restore the previous (looser) behavior for the
 * SubtleCrypto methods used by the TLS library.
 */

interface SubtleCrypto {
	importKey(
		format: 'raw' | 'pkcs8' | 'spki',
		keyData: ArrayBufferLike | ArrayBufferView,
		algorithm:
			| AlgorithmIdentifier
			| RsaHashedImportParams
			| EcKeyImportParams
			| HmacImportParams
			| AesKeyAlgorithm,
		extractable: boolean,
		keyUsages: KeyUsage[]
	): Promise<CryptoKey>;

	sign(
		algorithm: AlgorithmIdentifier | RsaHashedImportParams | EcdsaParams,
		key: CryptoKey,
		data: ArrayBufferLike | ArrayBufferView
	): Promise<ArrayBuffer>;

	verify(
		algorithm: AlgorithmIdentifier | RsaHashedImportParams | EcdsaParams,
		key: CryptoKey,
		signature: ArrayBufferLike | ArrayBufferView,
		data: ArrayBufferLike | ArrayBufferView
	): Promise<boolean>;

	encrypt(
		algorithm:
			| AlgorithmIdentifier
			| RsaOaepParams
			| AesCtrParams
			| AesCbcParams
			| AesGcmParams,
		key: CryptoKey,
		data: ArrayBufferLike | ArrayBufferView
	): Promise<ArrayBuffer>;

	decrypt(
		algorithm:
			| AlgorithmIdentifier
			| RsaOaepParams
			| AesCtrParams
			| AesCbcParams
			| AesGcmParams,
		key: CryptoKey,
		data: ArrayBufferLike | ArrayBufferView
	): Promise<ArrayBuffer>;

	digest(
		algorithm: AlgorithmIdentifier,
		data: ArrayBufferLike | ArrayBufferView
	): Promise<ArrayBuffer>;

	exportKey(
		format: 'raw' | 'pkcs8' | 'spki',
		key: CryptoKey
	): Promise<ArrayBuffer>;
	exportKey(format: 'jwk', key: CryptoKey): Promise<JsonWebKey>;
}
