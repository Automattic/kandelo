/**
 * Guest web preview protocol shared by the Kandelo page, the preview-origin
 * relay (`preview-origin/relay.js`) and the preview service worker
 * (`preview-origin/preview-service-worker.js`).
 *
 * WHY A SECOND ORIGIN: a guest web page (WordPress, nginx, any server inside a
 * machine) used to be served on Kandelo's own origin, so its scripts could
 * read and drive the Kandelo page, its storage and its credential prompt.
 * Guests are now served from a separate preview origin by its own service
 * worker, which forwards each request to the Kandelo tab that owns the
 * machine over a MessagePort handed through a hidden relay frame. See
 * docs/browser-support.md, "Guest web previews run on their own origin".
 *
 * The classic scripts (the relay, the preview service worker and
 * `public/blob-iframe-interceptor.js`) cannot import this module; keep their
 * copies of these values equal to the ones here. "the classic preview scripts
 * mirror the protocol constants" in `preview-bridge.test.ts` checks it.
 */

/** Every message carries `v`; both bundles must be deployed together. */
export const PREVIEW_PROTOCOL_VERSION = 3;

/** Relay page, relative to the deployment scope on the preview origin. */
export const PREVIEW_RELAY_PATH = "__kandelo_preview/relay.html";
/** Preview service worker script, relative to the deployment scope. */
export const PREVIEW_SERVICE_WORKER_PATH = "preview-service-worker.js";

/**
 * MACHINE NAMES CARRY A COMMITMENT. A machine's name is
 * `<adjective>-<color>-<noun>-<t>`, where `t` is the first 100 bits of
 * SHA-256 of the machine's secret `s` (32 lowercase hex digits, 128 random
 * bits, minted by the owning tab), written as 20 characters of lowercase
 * RFC 4648 base32 (`a-z`, `2-7`). Every guest page shares the preview origin
 * and can message the preview service worker through a relay window it
 * scripts, so the worker cannot tell an owner from another page by who sent
 * a message. It tells them apart by what they know: it binds a port to a
 * name, or drops one, only for a message whose `s` hashes to the name's own
 * `t`. Knowing the name (it is in every shareable link) gives no way to
 * find `s`. The check is stateless, so it survives worker restarts and new
 * worker versions. See docs/browser-support.md, "Guest web previews run on
 * their own origin".
 */
export const MACHINE_NAME_PATTERN = /^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}-[a-z2-7]{20}$/;
/** The three-word names Kandelo minted before names carried a commitment. */
export const LEGACY_MACHINE_NAME_PATTERN = /^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}$/;
export const MACHINE_SECRET_PATTERN = /^[0-9a-f]{32}$/;
export const MACHINE_COMMITMENT_LENGTH = 20;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** `t` for secret `s`: 100 bits of SHA-256(UTF-8 `s`), lowercase base32. */
export async function machineNameCommitment(secret: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
  );
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (let index = 0; out.length < MACHINE_COMMITMENT_LENGTH; index++) {
    buffer = (buffer << 8) | digest[index]!;
    bits += 8;
    while (bits >= 5 && out.length < MACHINE_COMMITMENT_LENGTH) {
      out += BASE32_ALPHABET[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}

/**
 * What the preview service worker's broadcasts to every relay
 * (`preview-need-bridge`, `preview-machine-status`) carry instead of a
 * machine's name: lowercase hex SHA-256 of the name's UTF-8 bytes. Any guest
 * page can listen to them through a relay it scripts; a hash lets the owner
 * and viewers of a machine recognize it without telling a listener names it
 * does not already know (a name ends in a 100-bit commitment).
 */
export async function machineNameHash(name: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const MACHINE_NAME_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** True when `secret` is the one `name` commits to. */
export async function secretProvesMachineName(name: string, secret: unknown): Promise<boolean> {
  if (!isMachineName(name) || typeof secret !== "string" || !MACHINE_SECRET_PATTERN.test(secret)) {
    return false;
  }
  return name.slice(-MACHINE_COMMITMENT_LENGTH) === await machineNameCommitment(secret);
}

/**
 * Sandbox for every guest preview frame. `allow-same-origin` is safe only
 * because the frame's origin is the preview origin, never Kandelo's: it keeps
 * the guest's own storage and service-worker control. Top navigation is
 * deliberately absent, so a guest cannot navigate the Kandelo tab away.
 */
export const PREVIEW_FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups " +
  "allow-popups-to-escape-sandbox allow-modals allow-downloads";

/** Cross-origin frames lose the `'self'` default of these features. */
export const PREVIEW_FRAME_ALLOW = "fullscreen; clipboard-write; autoplay";

/**
 * The relay needs scripts and its own origin (to register the preview service
 * worker) and nothing else; a guest that scripts the relay's window gains no
 * top navigation, popups or forms through it.
 */
export const PREVIEW_RELAY_SANDBOX = "allow-scripts allow-same-origin";

/**
 * `not-owner`: the message's secret does not hash to the name's commitment.
 * `superseded`: the worker already accepted a bind or closing of this name
 * with a larger sequence number, so this bind arrived late.
 * There is no `name-in-use`: a name is bound by whoever proves its secret,
 * and a fresh name's commitment is unique.
 */
export type PreviewRefusalCode = "not-owner" | "version-mismatch" | "superseded" | "invalid";

/**
 * Relay -> page. `preview-worker-changed` means the preview origin's active
 * service worker was replaced and holds no ports. Messages from the relay
 * never carry a machine's secret: any guest page can script a relay.
 */
export type RelayToPageMessage =
  | { type: "preview-relay-ready"; v: number }
  | { type: "preview-relay-failed"; v: number; error: string; errorName?: string }
  | { type: "preview-worker-changed"; v: number }
  | { type: "preview-bridge-ready"; v: number; name: string; seq: number }
  | { type: "preview-bridge-refused"; v: number; name: string; seq: number; code: PreviewRefusalCode }
  | { type: "preview-need-bridge"; v: number; nameHash: string }
  | { type: "preview-machine-status"; v: number; nameHash: string; status: "offline" };

/**
 * Page -> relay -> worker: `preview-bridge` (`name`, `secret`, `seq`, one
 * port) and `preview-machine-closing` (`name`, `secret`, `seq`). `seq` is a
 * positive integer the owner increases with every bind and closing of its
 * name; the worker ignores one no larger than the newest it accepted, and
 * echoes a bind's `seq` in its answer.
 * Guest document -> preview service worker: `preview-blob-document`
 * (`id`, `html`, `baseUrl`) and `preview-blob-revoked` (`id`), from
 * `public/blob-iframe-interceptor.js`.
 * Page <-> worker over a bridge port, besides requests: `bridge-ping` and
 * `bridge-pong` (`id`), the owner's check that the worker holds its port.
 */

/** Preview service worker -> page, over a machine's bridge port. */
export interface BridgeHttpRequest {
  type: "http-request";
  v: number;
  id: number;
  method: string;
  /** Path and query inside the machine, e.g. `/wp-admin/?x=1`. */
  url: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
  mode: string;
  destination: string;
  /** True for a document navigation (the frame's own page or a nested one). */
  navigation: boolean;
}

export interface BridgeProxyFetch {
  type: "proxy-fetch";
  v: number;
  id: number;
  url: string;
  method: string;
  headers: [string, string][];
}

export type BridgeRequestMessage = BridgeHttpRequest | BridgeProxyFetch;

/** Page -> preview service worker, over a machine's bridge port. */
export type BridgeResponseMessage =
  | {
    type: "http-response";
    v: number;
    id: number;
    status: number;
    headers: [string, string][];
    body: ArrayBuffer;
  }
  | { type: "http-error"; v: number; id: number; error: string };

/** `<scope>computer/<name>/`: the machine's path on either origin. */
export function machinePathPrefix(scope: string, name: string): string {
  return `${scope}computer/${name}/`;
}

export function previewRelayUrl(previewOrigin: string, scope: string): string {
  return `${previewOrigin}${scope}${PREVIEW_RELAY_PATH}`;
}

export function isMachineName(value: unknown): value is string {
  return typeof value === "string" && MACHINE_NAME_PATTERN.test(value);
}

/** A three-word name from before names carried a commitment; never served. */
export function isLegacyMachineName(value: unknown): value is string {
  return typeof value === "string" && LEGACY_MACHINE_NAME_PATTERN.test(value);
}
