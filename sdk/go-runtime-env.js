/**
 * Add an opt-in Go scheduler default for a guest process.
 * @param {readonly string[]} env Guest environment entries.
 * @param {{ hostHint?: number, budget?: number }} options CPU hint and the
 * embedding's per-process allowance after accounting for other workers.
 * @returns {string[]}
 */
export function goRuntimeEnv(env, { hostHint, budget }) {
  if (env.some(entry => entry.startsWith("GOMAXPROCS="))) return [...env];

  /** @param {number | undefined} value */
  const valid = value => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  const procs = valid(hostHint) && valid(budget) ? Math.min(hostHint, budget) : 1;
  return [...env, `GOMAXPROCS=${procs}`];
}
