function ipv6Number(host: string): bigint {
  const [left, right = ""] = host.slice(1, -1).split("::");
  const front = left ? left.split(":") : [];
  const back = right ? right.split(":") : [];
  const parts = [...front, ...Array(8 - front.length - back.length).fill("0"), ...back];
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

export function isPrivateHost(host: string): boolean {
  if (host.startsWith("[")) {
    const ip = ipv6Number(host);
    // Only global unicast, excluding special-use ranges inside 2000::/3.
    return ip >> 125n !== 1n ||
      ["2001::", "2001:20::", "2001:db8::", "2002::"].some(prefix => {
        const bits = prefix === "2001:20::" ? 28 : prefix === "2002::" ? 16 : 32;
        return ip >> BigInt(128 - bits) === ipv6Number(`[${prefix}]`) >> BigInt(128 - bits);
      });
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b, c] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113);
  }
  return host === "localhost" || [".localhost", ".local", ".internal"].some(suffix => host.endsWith(suffix));
}

export function validateTarget(value: string, proxy: URL): URL {
  // WHATWG otherwise repairs backslashes, controls, and missing scheme slashes.
  if (!/^https?:\/\//i.test(value) || /[\x00-\x20\\]/.test(value)) throw new Error("Invalid HTTP(S) URL");
  const url = new URL(value);
  if (url.username || url.password) throw new Error("URL containing forbidden user or password information");
  const host = url.hostname.replace(/\.$/, "");
  if (host === proxy.hostname.replace(/\.$/, "")) throw new Error("URL cannot target the CORS proxy host");
  if (isPrivateHost(host)) throw new Error("Private IPs and local hosts are forbidden");
  return url;
}
