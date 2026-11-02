/**
 * Which process, under which credential grant, wrote an outgoing guest HTTP
 * request, and whether that grant covers the request.
 *
 * A request belongs to the process whose system call wrote its bytes: the
 * pid the kernel was serving when `send`/`write` handed them to the network
 * backend. It does not belong to the process that opened the connection, so
 * a socket a granted process opened and a child inherited does not carry the
 * parent's grant. It also belongs to the grant that process held at that
 * moment, not whatever the pid holds when the request is dispatched: exec
 * keeps the pid, so bytes a process wrote before exec'ing a declared program
 * must not leave under the grant the new image receives. Grant ids are never
 * reused, so a grant issued after the write can never match. A request
 * assembled from bytes written by more than one (pid, grant) belongs to no
 * one and is never granted.
 *
 * Backends record a writer with `currentWriter` + `mergeRequestWriter` as
 * bytes arrive (synchronous host-side reads inside the kernel's
 * `host_net_send`; neither enters the kernel) and decide with
 * `credentialGrantForRequest` only when they dispatch the finished request.
 *
 * Only TLS connections are ever granted: grant destinations are HTTPS
 * origins, and bytes the guest sent in cleartext were never protected. A
 * cleartext or proxyless request that carries credentials is refused with
 * `refuseCredentialRequest`.
 */
import {
  type BrowserCorsProxyCredentialGrant,
  credentialRequestHeaderNames,
  type HttpHeaderOccurrence,
} from "./browser-cors-proxy";

/** The process, and the grant it held, that wrote some request bytes. */
export interface RequestWriter {
  /** Positive pid; 0 = unattributed; negative = several writers. */
  readonly pid: number;
  /** The grant id the host held for `pid` at the write; 0 = none. */
  readonly grantId: number;
}

/** No guest process wrote these bytes, or none is known. Never granted. */
export const UNATTRIBUTED_WRITER: RequestWriter = Object.freeze({ pid: 0, grantId: 0 });
/** More than one writer wrote the request. Never granted. */
export const MIXED_WRITERS: RequestWriter = Object.freeze({ pid: -1, grantId: 0 });

export interface CredentialAttributionOptions {
  /**
   * The pid whose system call the kernel is serving right now, or 0 outside
   * any guest system call. Read synchronously while bytes are handed to the
   * backend.
   */
  currentPid?: () => number;
  /**
   * The id of the grant the host holds for `pid` now, or 0. Read in the same
   * synchronous step as `currentPid`, so it must not enter the kernel (it
   * runs inside the kernel's own entry); the kernel confirms it at dispatch.
   */
  peekCredentialGrantId?: (pid: number) => number;
  /**
   * The tag a request written by `pid` under grant `grantId` to the exact
   * `origin` may carry, or null unless `pid` still holds that very grant and
   * it covers `origin`.
   *
   * WHY it may be asynchronous: the kernel worker answers from the kernel's
   * process table, and a kernel export cannot be entered while another one
   * holds the entry gate. `credentialGrantForRequest` calls this only after
   * yielding past the kernel entry that delivered the bytes, and the kernel
   * worker retries on contention.
   */
  credentialGrantFor?: (
    pid: number,
    grantId: number,
    origin: string,
  ) =>
    | BrowserCorsProxyCredentialGrant
    | null
    | Promise<BrowserCorsProxyCredentialGrant | null>;
}

/** The writer the kernel is serving now, with the grant it holds. */
export function currentWriter(options: CredentialAttributionOptions): RequestWriter {
  const pid = options.currentPid?.() ?? 0;
  if (!Number.isInteger(pid) || pid <= 0) return UNATTRIBUTED_WRITER;
  const grantId = options.peekCredentialGrantId?.(pid) ?? 0;
  return {
    pid,
    grantId: Number.isInteger(grantId) && grantId > 0 ? grantId : 0,
  };
}

/**
 * Fold one more write into a request's writer. `undefined` starts a request.
 * Any disagreement in pid or grant, or an unattributed write, makes the
 * whole request ungrantable.
 */
export function mergeRequestWriter(
  writer: RequestWriter | undefined,
  next: RequestWriter,
): RequestWriter {
  if (writer === undefined) return next;
  if (writer.pid === next.pid && writer.grantId === next.grantId) return writer;
  return writer.pid === 0 || next.pid === 0 ? UNATTRIBUTED_WRITER : MIXED_WRITERS;
}

/**
 * Decide whether a finished request the guest sent over TLS goes out
 * granted: exactly one process wrote it, holding a grant at the time, and
 * that same grant is still live and names the target's exact origin.
 *
 * The grant source is consulted only after this yields once, so it never
 * enters the kernel from within the kernel's own entry.
 */
export async function credentialGrantForRequest(
  options: CredentialAttributionOptions,
  writer: RequestWriter | undefined,
  targetUrl: string,
): Promise<BrowserCorsProxyCredentialGrant | null> {
  if (writer === undefined || writer.pid <= 0 || writer.grantId <= 0) return null;
  const source = options.credentialGrantFor;
  if (source === undefined) return null;
  const origin = new URL(targetUrl).origin;
  if (!origin.startsWith("https://")) return null;
  await Promise.resolve();
  return await source(writer.pid, writer.grantId, origin);
}

/** A credentialed request refused on a path no credential grant can cover. */
export class CredentialRequestRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialRequestRefusedError";
  }
}

/**
 * Refuse, visibly, a request carrying credential fields on a path no grant
 * can cover: a cleartext connection, or a TLS connection with no CORS proxy
 * to carry the grant's opt-in and tag. Credentials are never stripped.
 */
export function refuseCredentialRequest(
  method: string,
  targetUrl: string,
  headers: readonly HttpHeaderOccurrence[],
  reason: string,
): void {
  const names = credentialRequestHeaderNames(headers);
  if (names.length === 0) return;
  throw new CredentialRequestRefusedError(
    `Browser network cannot send ${method} request to ${new URL(targetUrl).origin} with credential request headers: ${names.join(", ")} (${reason})`,
  );
}

export const CLEARTEXT_CREDENTIAL_REASON =
  "the guest did not send it over TLS, so no credential grant can cover it";
export const PROXYLESS_CREDENTIAL_REASON =
  "no CORS proxy is configured to carry a credential grant";
