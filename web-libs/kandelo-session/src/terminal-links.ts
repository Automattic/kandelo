/**
 * Terminal link policy — decides what a URL printed in terminal output means
 * and how the page is allowed to open it.
 *
 * Two facts drive every decision:
 *
 * 1. **Whose network is the URL naming?** Text printed by a program running
 *    inside a Kandelo machine describes the machine's world, not the user's.
 *    `http://localhost:8080/` from an in-machine server names a socket in the
 *    machine's network namespace. The page can only reach that socket through
 *    the service-worker HTTP bridge, which forwards exactly one machine port
 *    to one same-origin URL prefix. Any other loopback port is simply not
 *    reachable from the page, and the user's own computer is a different
 *    machine that happens to answer the same name.
 * 2. **Should the current page's URL leak to the destination?** Kandelo pages
 *    carry machine state in the URL (`#k1=` boot descriptors, share links).
 *    Handing that to a third-party site as a `Referer` header leaks it. Only
 *    destinations that are the current machine — or the site hosting it — may
 *    see the referrer.
 *
 * This module is DOM-free so it can be unit tested. The xterm.js wiring that
 * consumes it lives in the browser app.
 */

/** The machine's web surface, as the hosting page can actually reach it. */
export interface MachineWebSurface {
  /**
   * URL of the surface root — the service worker's app prefix. May be
   * relative to the page (`/kandelo/computer/<name>/`); it is resolved against the page
   * URL before use.
   */
  readonly url: string;
  /**
   * The in-machine TCP port that `url` forwards to. Loopback URLs naming any
   * other port are not reachable through this surface.
   */
  readonly port: number;
}

export interface TerminalLinkContext {
  /** Absolute URL of the page hosting the terminal. */
  readonly pageUrl: string;
  /**
   * The machine's reachable web surface, or `null`/absent when no HTTP bridge
   * is running — in which case no loopback URL the machine prints is
   * reachable from the page.
   */
  readonly machine?: MachineWebSurface | null;
}

/**
 * Where a terminal link goes and what the browser may tell the destination.
 *
 * `unreachable` is a deliberate outcome, not an error: the text is a real URL,
 * but it names something this page cannot reach. Callers should leave such
 * text unlinked rather than offer a click that lands somewhere the user did
 * not mean — most importantly the user's own computer.
 */
export type TerminalLinkTarget =
  | {
    readonly kind: "machine";
    /** Absolute URL to open. */
    readonly href: string;
    /** True: the destination is the machine or its host site. */
    readonly sendReferrer: true;
  }
  | {
    readonly kind: "external";
    readonly href: string;
    /** False: never hand a third-party site this page's URL. */
    readonly sendReferrer: false;
  }
  | {
    readonly kind: "unreachable";
    /** Plain-language explanation, suitable for a log line or tooltip. */
    readonly reason: string;
  };

/** Scheme default ports, for loopback URLs written without an explicit port. */
const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  "http:": 80,
  "https:": 443,
};

/**
 * Hosts that resolve to "this computer". Inside a Kandelo machine these name
 * the machine; typed into the user's browser they name the user's laptop.
 * `0.0.0.0` and `::` are wildcard bind addresses that servers commonly print
 * as if they were reachable addresses.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0" || host === "[::]") return true;
  if (host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function effectivePort(url: URL): number | null {
  if (url.port) {
    const parsed = Number(url.port);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return DEFAULT_PORTS[url.protocol] ?? null;
}

/**
 * Re-express an in-machine loopback URL as the page-reachable surface URL that
 * forwards to it, preserving path, query and fragment.
 */
function rebaseOntoSurface(url: URL, surface: MachineWebSurface, pageUrl: string): string | null {
  let root: URL;
  try {
    root = new URL(surface.url, pageUrl);
  } catch {
    return null;
  }
  if (!root.pathname.endsWith("/")) root.pathname += "/";
  root.search = "";
  root.hash = "";

  const relative = url.pathname.replace(/^\/+/, "") + url.search + url.hash;
  let rebased: URL;
  try {
    rebased = new URL(relative || ".", root);
  } catch {
    return null;
  }
  // `new URL` already normalized any `..` segments; refuse anything that
  // escaped the surface root rather than silently pointing at the host page.
  if (rebased.origin !== root.origin) return null;
  if (!rebased.pathname.startsWith(root.pathname)) return null;
  return rebased.href;
}

/**
 * Classify one URL found in terminal output.
 *
 * Returns `null` when `raw` is not an http(s) URL at all — callers should not
 * linkify it. Other schemes are excluded on purpose: `javascript:` and
 * `data:` URLs written by a program are a script-injection vector, and
 * `file:` names the user's disk rather than the machine's.
 */
export function classifyTerminalLink(
  raw: string,
  context: TerminalLinkContext,
): TerminalLinkTarget | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  if (isLoopbackHost(url.hostname)) {
    const machine = context.machine;
    if (!machine) {
      return {
        kind: "unreachable",
        reason:
          "This machine has no web bridge, so nothing in the browser can reach its local ports.",
      };
    }
    const port = effectivePort(url);
    if (port === null) {
      return { kind: "unreachable", reason: `${raw} does not name a usable port.` };
    }
    if (port !== machine.port) {
      return {
        kind: "unreachable",
        reason:
          `The web bridge only forwards this machine's port ${machine.port}, ` +
          `so port ${port} is not reachable from the browser.`,
      };
    }
    const href = rebaseOntoSurface(url, machine, context.pageUrl);
    if (!href) {
      return {
        kind: "unreachable",
        reason: "This machine's web surface URL could not be resolved.",
      };
    }
    return { kind: "machine", href, sendReferrer: true };
  }

  let page: URL;
  try {
    page = new URL(context.pageUrl);
  } catch {
    return { kind: "external", href: url.href, sendReferrer: false };
  }
  if (url.origin === page.origin) {
    return { kind: "machine", href: url.href, sendReferrer: true };
  }
  return { kind: "external", href: url.href, sendReferrer: false };
}
