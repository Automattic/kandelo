/**
 * Rewrites a guest server's response so it works under the machine's preview
 * prefix, `<preview origin><scope>computer/<name>/`.
 *
 * A guest server believes it is the root of its host, so it writes absolute
 * URLs (`http://<host>/wp-content/x.css`, `Location: /wp-admin/`) that would
 * escape the machine's prefix. The forwarded headers (`X-Forwarded-Host`,
 * `X-Forwarded-Prefix`) let servers that honor them (WordPress through
 * `lib/init/wordpress-runtime-config.ts`) produce correct URLs themselves;
 * this covers the rest. Moved from Kandelo's service worker into the owning
 * tab together with the cookie jar.
 */

export interface PreviewLocation {
  /** `http://127.0.0.1:5402` */
  previewOrigin: string;
  /** `<scope>computer/<name>` with no trailing slash. */
  machineRoot: string;
}

/** Content types whose text is rewritten. */
export function shouldRewriteBody(headers: Headers): boolean {
  if (headers.has("Content-Encoding")) return false;
  const type = (headers.get("Content-Type") ?? "").toLowerCase();
  return type.startsWith("text/html") ||
    type.startsWith("text/css") ||
    type.startsWith("text/javascript") ||
    type.startsWith("application/javascript") ||
    type.startsWith("application/x-javascript") ||
    type.startsWith("application/json") ||
    type.includes("+json") ||
    type.startsWith("application/xml") ||
    type.startsWith("text/xml") ||
    type.includes("+xml") ||
    type.startsWith("image/svg+xml");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Re-home same-host absolute URLs in `text` under the machine prefix.
 *
 * A URL already under the prefix is left alone when the prefix is followed by
 * more path, a delimiter that ends the URL token, or end of text. Matching
 * only "/" or end of text re-prefixed a bare prefix such as
 * `.../computer/<name>"` (WordPress's WP_HOME link) into
 * `.../computer/<name>/computer/<name>`.
 */
export function rewriteSameHostUrls(text: string, location: PreviewLocation): string {
  const origin = new URL(location.previewOrigin);
  const host = origin.host;
  const publicOrigin = `${origin.protocol}//${host}/`;
  const publicBase = `${origin.protocol}//${host}${location.machineRoot}/`;
  const hostPattern = escapeRegExp(host);
  const rootPattern = escapeRegExp(location.machineRoot.slice(1));
  const urlEnd = "[?#\"'\\s<>)]";
  const plain = new RegExp(
    `http://${hostPattern}/(?!${rootPattern}(?:/|$|${urlEnd}))`,
    "g",
  );
  const escapedRoot = rootPattern.replace(/\//g, "\\\\/");
  const escaped = new RegExp(
    `http:\\\\/\\\\/${hostPattern}\\\\/(?!${escapedRoot}(?:\\\\/|$|${urlEnd}))`,
    "g",
  );
  const encodedRoot = rootPattern.replace(/\//g, "%2F");
  const encoded = new RegExp(
    `http%3A%2F%2F${hostPattern}%2F(?!${encodedRoot}(?:%2F|$|${urlEnd}))`,
    "gi",
  );
  return text
    .replace(plain, publicBase)
    .replace(escaped, publicBase.replace(/\//g, "\\/"))
    .replace(encoded, encodeURIComponent(publicBase))
    .replace(new RegExp(`http://${hostPattern}/`, "g"), publicOrigin)
    .replace(new RegExp(`http:\\\\/\\\\/${hostPattern}\\\\/`, "g"), publicOrigin.replace(/\//g, "\\/"))
    .replace(new RegExp(`http%3A%2F%2F${hostPattern}%2F`, "gi"), encodeURIComponent(publicOrigin));
}

/**
 * Re-home a redirect target. Same-host targets move under the machine prefix
 * and take the preview origin's scheme (avoiding mixed content on HTTPS);
 * other hosts are left as the guest wrote them.
 */
export function rewriteLocation(
  value: string,
  requestUrl: URL,
  location: PreviewLocation,
): string {
  const target = new URL(value, requestUrl);
  if (target.hostname === requestUrl.hostname) {
    target.protocol = requestUrl.protocol;
    if (target.pathname !== location.machineRoot && !target.pathname.startsWith(`${location.machineRoot}/`)) {
      target.pathname = location.machineRoot + target.pathname;
    }
  }
  return target.href;
}

/**
 * Insert the blob-iframe interceptor as the first <head> child so it runs
 * before any guest script creates a `blob:` iframe. Without it, an app that
 * mounts an iframe from a `blob:` URL (the WordPress block/site editor
 * canvas) gets a document no service worker controls, whose subresources
 * escape the bridge. See `public/blob-iframe-interceptor.js`.
 */
export function injectBlobIframeInterceptor(html: string, source: string): string {
  if (!source || html.includes("__kandeloBlobIframePatched")) return html;
  const tag = `<script>${source}</script>`;
  const head = html.match(/<head[^>]*>/i);
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  const root = html.match(/<html[^>]*>/i);
  if (root && root.index !== undefined) {
    const at = root.index + root[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}

/**
 * True when a Content Security Policy governs scripts: some policy has
 * `script-src`, `script-src-elem` or `default-src`. A policy with only other
 * directives (WordPress's admin pages send just `frame-ancestors 'self'`)
 * says nothing about inline scripts, so a helper script does not change what
 * it allows.
 */
export function cspRestrictsScripts(policies: string | null): boolean {
  if (!policies) return false;
  return policies.split(",").some((policy) =>
    policy.split(";").some((directive) =>
      /^(?:script-src|script-src-elem|default-src)(?:\s|$)/i.test(directive.trim())
    )
  );
}

/**
 * Map a guest's own framing policy onto the preview presentation.
 *
 * A guest that allows only same-origin framing (`X-Frame-Options:
 * SAMEORIGIN`, `frame-ancestors 'self'`: WordPress's login and admin pages,
 * Adminer) means "only my own site may frame me". Its pages used to be served
 * on Kandelo's origin, so Kandelo's page was that same-origin embedder. They
 * now run on the preview origin inside Kandelo's page, so the Kandelo origin
 * that hosts the preview is added beside `'self'`. Nothing else is loosened:
 * `DENY`, `'none'`, and every other source are kept as the guest wrote them,
 * and a third-party site still cannot frame the guest.
 */
export function translateFramePolicy(headers: Headers, appOrigin: string): void {
  const policies = headers.get("content-security-policy");
  let hasFrameAncestors = false;
  if (policies) {
    const rewritten = policies.split(",").map((policy) =>
      policy.split(";").map((directive) => {
        const trimmed = directive.trim();
        if (!/^frame-ancestors(?:\s|$)/i.test(trimmed)) return directive;
        hasFrameAncestors = true;
        const sources = trimmed.split(/\s+/).slice(1);
        if (!sources.some((source) => source.toLowerCase() === "'self'")) return directive;
        if (sources.includes(appOrigin)) return directive;
        return ` ${trimmed} ${appOrigin}`;
      }).join(";")
    ).join(",");
    if (rewritten !== policies) headers.set("content-security-policy", rewritten);
  }
  const frameOptions = headers.get("x-frame-options")?.trim().toLowerCase();
  if (!hasFrameAncestors && frameOptions === "sameorigin") {
    // Browsers ignore X-Frame-Options when a frame-ancestors policy exists;
    // express the same intent in the form that can name the embedder.
    headers.delete("x-frame-options");
    headers.append("content-security-policy", `frame-ancestors 'self' ${appOrigin}`);
  }
}
