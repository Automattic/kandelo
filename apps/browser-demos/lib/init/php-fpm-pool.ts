/** Apply the host's upper bound without raising the image's configured pool. */
export function limitPhpFpmPool(config: string, limit: number): string {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Invalid PHP-FPM pool limit");
  const setting = /^([ \t]*pm\.max_children[ \t]*=[ \t]*)(\d+)([ \t]*(?:;[^\r\n]*)?\r?)$/gm;
  const matches = [...config.matchAll(setting)];
  // The shipped images have one explicit static pool. Preserve other configurations
  // (dynamic pools, includes, environment expansion, multiple pools) and let FPM and the
  // normal process budget handle them; never replace them with a template.
  if (matches.length !== 1
      || [...config.matchAll(/^[ \t]*pm\.max_children[ \t]*=/gm)].length !== 1
      || /^[ \t]*include[ \t]*=/m.test(config)
      || !/^[ \t]*pm[ \t]*=[ \t]*static[ \t]*(?:;[^\r\n]*)?\r?$/m.test(config)) return config;
  const workers = Number(matches[0]![2]);
  if (!Number.isSafeInteger(workers) || workers < 1 || workers <= limit) return config;
  return config.replace(setting, (_match, prefix: string, _workers: string, suffix: string) => `${prefix}${limit}${suffix}`);
}
