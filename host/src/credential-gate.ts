/**
 * The kernel worker's half of the browser app's service-worker credential
 * gate.
 *
 * The kernel worker is the first gate: `BrowserCorsProxy` adds credentials,
 * the proxy's opt-in and a grant's tag only to a request a granted process
 * wrote (`credential-grants.ts`, `networking/request-attribution.ts`). The
 * app's service worker (`apps/browser-demos/public/service-worker.js`) is a
 * second, independent gate at the browser's network edge. It refuses every
 * request to the CORS proxy that carries credentials or the opt-in without a
 * tag, and before it lets a tagged request through it asks the kernel worker
 * that sent it whether the tag names a live grant for that destination. It
 * removes the tag before the request leaves the browser.
 *
 * WHY this transport. The service worker cannot message a dedicated worker
 * directly in every engine: Chromium has no `navigator.serviceWorker` in
 * workers, so `Client.postMessage()` to the kernel worker's client is never
 * delivered (measured 2026-10-29; WebKit and Firefox deliver it). So the
 * service worker asks over a same-origin `BroadcastChannel`, which every
 * engine delivers to workers, and the kernel worker that holds the tag
 * answers with a `fetch` to the service worker's reply URL. The browser
 * stamps that fetch with the sender's client id, which no script can forge,
 * so the service worker accepts only the answer of the client that sent the
 * tagged request, and it asks only when that client runs exactly the kernel
 * worker's entry script. A broadcast is visible to every same-origin
 * listener, so it carries the token's SHA-256 hash, never the token.
 *
 * The guarantee is that only the kernel worker's script can present and
 * vouch for a tag. Any script the app's origin runs can still start a
 * genuine kernel worker and answer that kernel's prompt itself.
 *
 * Browser kernel worker only: the Node host has no service worker.
 */
import type { CredentialGrants } from "./credential-grants";

/** The `BroadcastChannel` the service worker and kernel workers share. */
export const CREDENTIAL_GATE_CHANNEL = "kandelo-credential-grants";

/** Service worker → kernel workers: is the token with this hash yours? */
export interface CredentialGateVerifyMessage {
  type: "credential-grant-verify";
  /** The service worker's id for this question. */
  id: string;
  /** `credentialTokenHash(token)` of the tag the request carried. */
  tokenHash: string;
  /** The target origin the tagged request is for. */
  origin: string;
  /** Where the holder answers: a URL only the service worker serves. */
  replyUrl: string;
}

/** Kernel worker → service worker (the body of the reply fetch). */
export interface CredentialGateReply {
  type: "credential-grant-verified";
  id: string;
  valid: boolean;
}

/** Kernel worker → service worker: drop any cached answer for this grant. */
export interface CredentialGateEndedMessage {
  type: "credential-grant-ended";
  tokenHash: string;
}

export type CredentialGateMessage =
  | CredentialGateVerifyMessage
  | CredentialGateEndedMessage;

const MAX_FIELD_LENGTH = 2048;

/** SHA-256 of the token's UTF-8 bytes, base64url without padding. */
export async function credentialTokenHash(token: string): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The subset of `BroadcastChannel` the responder uses. */
export interface CredentialGateChannel {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: CredentialGateMessage): void;
  close(): void;
}

export interface CredentialGateResponderOptions {
  grants: Pick<CredentialGrants, "heldTokens">;
  /**
   * `CredentialGrants.verify`, which enters the kernel: the caller runs it
   * outside any kernel entry (retrying while the gate is busy). A rejection
   * answers invalid.
   */
  verify(token: string, origin: string): Promise<boolean>;
  /** This worker's origin; answers go only to a same-origin reply URL. */
  origin: string;
  channel: CredentialGateChannel;
  fetch(url: string, init: RequestInit): Promise<unknown>;
}

function isField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_FIELD_LENGTH;
}

/**
 * Answers the service worker's questions about this kernel worker's grants,
 * and tells it when a grant it asked about ends.
 */
export class CredentialGateResponder {
  readonly #options: CredentialGateResponderOptions;
  // Hashes of held tokens, computed while answering. Every token the
  // service worker can have cached is among them, so only these need an end
  // announcement.
  readonly #hashes = new Map<string, string>();

  constructor(options: CredentialGateResponderOptions) {
    this.#options = options;
    options.channel.onmessage = (event) => {
      void this.#answer(event.data).catch(() => {});
    };
  }

  /** Call when `CredentialGrants` ends a grant (`onGrantEnded`). */
  grantEnded(token: string): void {
    const tokenHash = this.#hashes.get(token);
    if (tokenHash === undefined) return;
    this.#hashes.delete(token);
    this.#options.channel.postMessage({ type: "credential-grant-ended", tokenHash });
  }

  close(): void {
    this.#options.channel.onmessage = null;
    this.#options.channel.close();
  }

  async #answer(data: unknown): Promise<void> {
    if (!data || typeof data !== "object") return;
    const message = data as Partial<CredentialGateVerifyMessage>;
    if (
      message.type !== "credential-grant-verify" || !isField(message.id) ||
      !isField(message.tokenHash) || !isField(message.origin) ||
      !isField(message.replyUrl)
    ) {
      return;
    }
    let replyUrl: URL;
    try {
      replyUrl = new URL(message.replyUrl);
    } catch {
      return;
    }
    if (replyUrl.origin !== this.#options.origin) return;

    const token = await this.#heldTokenWithHash(message.tokenHash);
    // Another kernel worker's tag, or one this worker no longer holds: only
    // the holder answers, and the service worker refuses on silence.
    if (token === null) return;
    let valid = false;
    try {
      valid = await this.#options.verify(token, message.origin);
    } catch {
      valid = false;
    }
    const reply: CredentialGateReply = {
      type: "credential-grant-verified",
      id: message.id,
      valid,
    };
    await this.#options.fetch(replyUrl.href, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reply),
      cache: "no-store",
    }).catch(() => {});
  }

  async #heldTokenWithHash(tokenHash: string): Promise<string | null> {
    for (const token of this.#options.grants.heldTokens()) {
      let hash = this.#hashes.get(token);
      if (hash === undefined) {
        hash = await credentialTokenHash(token);
        // The grant may have ended while hashing; never remember it then.
        if (!this.#options.grants.heldTokens().includes(token)) continue;
        this.#hashes.set(token, hash);
      }
      if (hash === tokenHash) return token;
    }
    return null;
  }
}
