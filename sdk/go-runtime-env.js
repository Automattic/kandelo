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
  const positiveIntegerOrOne = value =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 1;
  const procs = Math.min(positiveIntegerOrOne(hostHint), positiveIntegerOrOne(budget));
  return [...env, `GOMAXPROCS=${procs}`];
}
