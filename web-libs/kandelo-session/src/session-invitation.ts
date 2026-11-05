import { validateSessionOffer, type SessionOffer } from "./package-sessions";

/** An activity invitation carries bounded display fields, never executable code. */
export const SESSION_INVITATION_PREFIX = "#ks1=";
const MAX_INVITATION_BYTES = 8192;

export function encodeSessionInvitation(offer: SessionOffer): string {
  validateSessionOffer(offer);
  const bytes = new TextEncoder().encode(JSON.stringify(offer));
  if (bytes.length > MAX_INVITATION_BYTES) throw new Error("Session invitation is too large");
  return SESSION_INVITATION_PREFIX + btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeSessionInvitation(fragment: string): SessionOffer | null {
  if (!fragment.startsWith(SESSION_INVITATION_PREFIX)) {
    if (/^#ks\d/.test(fragment)) throw new Error("Unsupported session invitation version");
    return null;
  }
  const encoded = fragment.slice(SESSION_INVITATION_PREFIX.length);
  if (!encoded || encoded.length > Math.ceil(MAX_INVITATION_BYTES * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) {
    throw new Error("Invalid session invitation encoding");
  }
  const bytes = Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - encoded.length % 4) % 4)), c => c.charCodeAt(0));
  const offer: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  validateSessionOffer(offer);
  if (encodeSessionInvitation(offer) !== fragment) throw new Error("Noncanonical session invitation encoding");
  return offer;
}
