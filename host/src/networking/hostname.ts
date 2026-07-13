const DNS_MAX_WIRE_OCTETS = 255;
const DNS_MAX_LABEL_OCTETS = 63;

function nameNotFoundError(hostname: string): Error & { errno: number } {
  return Object.assign(new Error(`ENOENT: ${hostname}`), { errno: 2 });
}

/**
 * Parse the decimal forms accepted by inet_aton(3): a, a.b, a.b.c, and
 * a.b.c.d. In the shorter forms the final component occupies all remaining
 * address bits. Inputs made only of digits and dots are numeric candidates,
 * so malformed or overflowing candidates fail instead of falling through to
 * DNS (or wrapping when copied into a Uint8Array).
 */
export function parseNumericIpv4Hostname(hostname: string): Uint8Array | null {
  if (!/^[0-9.]+$/.test(hostname)) return null;
  if (!/^\d+(?:\.\d+){0,3}$/.test(hostname)) {
    throw nameNotFoundError(hostname);
  }

  const parts = hostname.split(".");
  const widths = parts.length === 1
    ? [32n]
    : parts.length === 2
      ? [8n, 24n]
      : parts.length === 3
        ? [8n, 8n, 16n]
        : [8n, 8n, 8n, 8n];

  let packed = 0n;
  for (let i = 0; i < parts.length; i++) {
    const value = BigInt(parts[i]);
    const width = widths[i];
    if (value > ((1n << width) - 1n)) {
      throw nameNotFoundError(hostname);
    }
    packed = (packed << width) | value;
  }

  return new Uint8Array([
    Number((packed >> 24n) & 0xffn),
    Number((packed >> 16n) & 0xffn),
    Number((packed >> 8n) & 0xffn),
    Number(packed & 0xffn),
  ]);
}

/**
 * Validate an ASCII DNS hostname at the DNS wire-format boundary. A single
 * trailing dot is the root label and remains part of the caller's hostname;
 * it is removed only while checking the preceding labels.
 */
export function validateDnsHostname(hostname: string): void {
  const absoluteName = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (absoluteName.length === 0 || !/^[\x00-\x7f]+$/.test(absoluteName)) {
    throw nameNotFoundError(hostname);
  }

  let wireOctets = 1; // Terminal root label.
  for (const label of absoluteName.split(".")) {
    if (
      label.length === 0 ||
      label.length > DNS_MAX_LABEL_OCTETS ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
    ) {
      throw nameNotFoundError(hostname);
    }
    wireOctets += 1 + label.length;
  }

  if (wireOctets > DNS_MAX_WIRE_OCTETS) {
    throw nameNotFoundError(hostname);
  }
}

/**
 * Validate a name before a browser fetch/TLS backend assigns it a synthetic
 * address. These backends defer the real lookup to fetch(), so they must reject
 * names that the browser environment already knows cannot resolve.
 */
export function validateSyntheticDnsHostname(
  hostname: string,
  aliases?: Record<string, string>,
): void {
  validateDnsHostname(hostname);

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
    throw nameNotFoundError(hostname);
  }
}
