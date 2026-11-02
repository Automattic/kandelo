/**
 * One machine's HTTP cookie jar, held in the memory of the Kandelo tab that
 * owns the machine.
 *
 * WHY HERE: guest servers set cookies with `Set-Cookie`, but a service
 * worker's synthetic response cannot hand them to the browser's cookie store,
 * and the browser would keep them past the machine's life if it could. The
 * jar used to live in Kandelo's service worker and was persisted to Cache
 * Storage, where any same-origin guest page could read every machine's
 * cookies. It now lives beside the machine: never persisted, never returned
 * to the browser, dropped with the machine. Guests never see HttpOnly cookies
 * or another machine's jar, and a preview service worker restart loses only
 * the bridge port.
 *
 * Cookies are identified by name AND path (RFC 6265): WordPress sets the same
 * auth cookie name for ADMIN_COOKIE_PATH (`/wp-admin`) and
 * PLUGINS_COOKIE_PATH (`/wp-content/plugins`), and keying by name alone
 * would drop one of them. The domain is always the machine.
 */

export const COOKIE_JAR_MAX_COOKIES = 32;
const COOKIE_NAME_MAX_BYTES = 256;
const COOKIE_VALUE_MAX_BYTES = 4096;
const COOKIE_PATH_MAX_BYTES = 4096;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const INVALID_COOKIE_FIELD_PATTERN = /[\u0000-\u001f\u007f;]/;

export interface StoredCookie {
  name: string;
  value: string;
  /** Full path on the preview origin, under the machine's prefix. */
  path: string;
  /** Expiry in epoch milliseconds; absent for a session cookie. */
  expires?: number;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function parseSetCookie(header: string, now: number): StoredCookie | null {
  const parts = header.split(";").map((part) => part.trim());
  const first = parts[0] ?? "";
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const cookie: StoredCookie = {
    name: first.slice(0, eq),
    value: first.slice(eq + 1),
    path: "/",
  };
  for (const attribute of parts.slice(1)) {
    const lower = attribute.toLowerCase();
    if (lower.startsWith("path=")) {
      cookie.path = attribute.slice(5) || "/";
    } else if (lower.startsWith("expires=")) {
      const time = new Date(attribute.slice(8)).getTime();
      if (!Number.isNaN(time) && cookie.expires === undefined) cookie.expires = time;
    } else if (lower.startsWith("max-age=")) {
      const seconds = Number.parseInt(attribute.slice(8), 10);
      // Max-Age wins over Expires (RFC 6265 5.3 step 3); zero or less
      // expires the cookie at once (5.2.2).
      if (!Number.isNaN(seconds)) cookie.expires = seconds <= 0 ? 0 : now + seconds * 1000;
    }
  }
  return cookie;
}

export class MachineCookieJar {
  private readonly cookies = new Map<string, StoredCookie>();

  /**
   * @param machinePrefix `<scope>computer/<name>` with no trailing slash. A
   *   guest sets paths relative to its own root (`/`, `/wp-admin`); the jar
   *   stores them under this prefix so they match the preview URL path.
   */
  constructor(private readonly machinePrefix: string, private readonly now = () => Date.now()) {}

  /** Store every `Set-Cookie` value of one response. */
  store(setCookieValues: readonly string[]): void {
    const now = this.now();
    for (const header of setCookieValues) {
      const cookie = parseSetCookie(header, now);
      if (!cookie) continue;
      if (!cookie.path.startsWith("/")) cookie.path = "/";
      if (cookie.path !== this.machinePrefix && !cookie.path.startsWith(`${this.machinePrefix}/`)) {
        cookie.path = this.machinePrefix + cookie.path;
      }
      if (!this.valid(cookie)) continue;
      const key = `${cookie.name}\n${cookie.path}`;
      if (cookie.expires !== undefined && cookie.expires < now) {
        this.cookies.delete(key);
        continue;
      }
      if (!this.cookies.has(key) && this.cookies.size >= COOKIE_JAR_MAX_COOKIES) continue;
      this.cookies.set(key, cookie);
    }
  }

  /** The `Cookie` header value for a request to `path` (a full preview path). */
  headerFor(path: string): string {
    const now = this.now();
    const matches: StoredCookie[] = [];
    for (const [key, cookie] of this.cookies) {
      if (cookie.expires !== undefined && cookie.expires < now) {
        this.cookies.delete(key);
        continue;
      }
      if (pathMatches(path, cookie.path)) matches.push(cookie);
    }
    // RFC 6265 5.4: longer paths first.
    matches.sort((a, b) => b.path.length - a.path.length);
    return matches.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  /** Names and paths only, for diagnostics; never the values. */
  entries(): Array<{ name: string; path: string }> {
    return [...this.cookies.values()].map(({ name, path }) => ({ name, path }));
  }

  clear(): void {
    this.cookies.clear();
  }

  private valid(cookie: StoredCookie): boolean {
    return COOKIE_NAME_PATTERN.test(cookie.name) &&
      byteLength(cookie.name) <= COOKIE_NAME_MAX_BYTES &&
      !INVALID_COOKIE_FIELD_PATTERN.test(cookie.value) &&
      byteLength(cookie.value) <= COOKIE_VALUE_MAX_BYTES &&
      !INVALID_COOKIE_FIELD_PATTERN.test(cookie.path) &&
      byteLength(cookie.path) <= COOKIE_PATH_MAX_BYTES &&
      (cookie.expires === undefined || Number.isFinite(cookie.expires));
  }
}

/** RFC 6265 5.1.4 path-match. */
export function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}
