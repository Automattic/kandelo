function setting(text: string, name: string, pattern: RegExp): RegExpMatchArray {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Expected one ${name} setting; found ${matches.length}`);
  return matches[0]!;
}

const fpmWorkers = /^([ \t]*pm\.max_children[ \t]*=[ \t]*)(\d+)([ \t]*(?:;[^\r\n]*)?\r?)$/gm;
const frankenThreads = /^(FRANKENPHP_NUM_THREADS=)(\d+)([ \t]*(?:#[^\r\n]*)?\r?)$/gm;

export function phpFpmWorkerCount(config: string): number {
  return Number(setting(config, "PHP-FPM pm.max_children", fpmWorkers)[2]);
}

/** Configure the same explicit PHP capacity in both shipped service configs. */
export function comparisonWorkerPools(fpm: string, franken: string, workers: number): {
  fpm: string;
  franken: string;
} {
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 32) {
    throw new RangeError("PHP workers must be an integer from 1 through 32");
  }
  setting(fpm, "PHP-FPM pm.max_children", fpmWorkers);
  setting(franken, "FRANKENPHP_NUM_THREADS", frankenThreads);
  const replace = (_match: string, prefix: string, _value: string, suffix: string) => `${prefix}${workers}${suffix}`;
  return { fpm: fpm.replace(fpmWorkers, replace), franken: franken.replace(frankenThreads, replace) };
}
