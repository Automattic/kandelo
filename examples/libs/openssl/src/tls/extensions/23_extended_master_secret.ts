/**
 * Extended Master Secret Extension (RFC 7627)
 * https://datatracker.ietf.org/doc/html/rfc7627
 *
 * This extension changes the master secret derivation to include a hash
 * of the handshake messages, preventing certain MITM attacks. The extension
 * data is empty in both directions — it's purely a presence/absence flag.
 *
 * OpenSSL 3.x requires this extension by default and will send
 * handshake_failure if the server doesn't echo it.
 */

import { ExtensionTypes } from './types';

export type ExtendedMasterSecret = Record<string, never>;

export const ExtendedMasterSecretExtension = {
	decodeFromClient(_data: Uint8Array): ExtendedMasterSecret {
		// Extension data is empty — it's just a flag
		return {};
	},

	encodeForClient(): Uint8Array {
		const extensionType = ExtensionTypes.extended_master_secret;
		// Extension data is empty
		return new Uint8Array([
			(extensionType >> 8) & 0xff,
			extensionType & 0xff,
			0,
			0, // zero-length extension data
		]);
	},
};
