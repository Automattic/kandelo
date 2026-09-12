/**
 * Name policy owned by the browser network backends, and by nothing else.
 *
 * `inet_aton(3)`'s numeric grammar and DNS host-name syntax used to live here
 * and are now the kernel's: `crates/runtime-core/src/hostname.rs`, reached from
 * `sys_getaddrinfo`. By the time a backend is asked to resolve a name, that
 * name is already known to be a syntactically valid host name and not a numeric
 * address, so no backend re-derives either fact.
 *
 * What remains is specific to a backend that *fabricates* an address instead of
 * resolving one. The fetch and TLS backends hand back a synthetic IP and defer
 * the real lookup to `fetch()`, so they cannot report a resolution failure
 * afterwards; a name the environment already knows cannot resolve has to be
 * refused now. RFC 6761 section 6.4 makes `.invalid` exactly that name. The
 * host's own alias table wins over the rule, the way an `/etc/hosts` entry wins
 * over DNS, and that table is host configuration the kernel is never given.
 */
export function validateSyntheticDnsHostname(
  hostname: string,
  aliases?: Record<string, string>,
): void {
  const absoluteName = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  const lowerName = absoluteName.toLowerCase();
  if (
    aliases &&
    (Object.prototype.hasOwnProperty.call(aliases, absoluteName) ||
      Object.prototype.hasOwnProperty.call(aliases, lowerName))
  ) {
    return;
  }
  if (lowerName === "invalid" || lowerName.endsWith(".invalid")) {
    throw Object.assign(new Error(`ENOENT: ${hostname}`), { errno: 2 });
  }
}
