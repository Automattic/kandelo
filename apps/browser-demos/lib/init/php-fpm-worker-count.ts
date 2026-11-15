/** Preserve a single-pool image's worker request within the host's budget. */
export function cappedPhpFpmWorkerCount(config: string, hostLimit: number): number {
  if (!Number.isSafeInteger(hostLimit) || hostLimit <= 0) {
    throw new Error(`invalid PHP-FPM host worker limit: ${hostLimit}`);
  }
  const requests = [...config.matchAll(/^\s*pm\.max_children\s*=\s*([^\r\n]*)/gm)];
  if (requests.length !== 1) throw new Error("PHP-FPM image must declare one pm.max_children worker request");
  const value = requests[0][1].split(/[;#]/, 1)[0].trim();
  const requested = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new Error(`invalid PHP-FPM image worker request: ${value}`);
  }
  return Math.min(requested, hostLimit);
}
