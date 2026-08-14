type RunnerEnvironment = Readonly<Record<string, string | undefined>>;

export interface ResolvedBuiltinPrograms {
  programs: Record<string, string | null>;
  snapshotNames: ReadonlySet<string>;
}

/**
 * Select the generic runner's implicit program set.
 *
 * Formula tests use `explicit` because their executable closure is supplied by
 * the tap's staged bottles. Other run-example consumers retain the default
 * resolver-managed convenience programs.
 */
export function resolveRunExampleBuiltinPrograms(
  env: RunnerEnvironment,
  resolveDefaults: () => ResolvedBuiltinPrograms,
): ResolvedBuiltinPrograms {
  const configured = env.KANDELO_RUNNER_BUILTINS;
  const mode = configured === undefined || configured === ""
    ? "default"
    : configured;
  if (mode === "default") return resolveDefaults();
  if (mode === "explicit") {
    return { programs: {}, snapshotNames: new Set() };
  }
  throw new Error(
    'KANDELO_RUNNER_BUILTINS must be "default" or "explicit"',
  );
}
