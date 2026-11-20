// What `delo add`, `remove`, `write`, `enable` and `disable` would change in a
// computer, decided from the registry and the computer's configuration. Kept
// pure so the rules are testable without a computer: the page applies the
// plan.
//
// A computer has exactly one pipeline, its own. Adding a binary puts it in
// the pipeline's `use`; enabling an option puts it in the pipeline's
// `enable`. Adding a registered pipeline copies its `use`, `enable`,
// `provide`, `need`, `device` and `files` into the computer's pipeline, so
// the registered pipeline is no longer a unit of the computer: its binaries
// are removed one by one. A pipeline that writes a path the computer already
// writes is refused by name, unless both write text there, and so is
// removing a binary whose file the pipeline adds to. `delo write` puts one
// file in the pipeline, or replaces the one at its path, and `delo remove
// <path>` deletes it; text on a path a binary writes goes at the end of that
// file, and any other file there is refused. A computer
// installs the binaries its pipeline uses, the binaries its options use, and every dependency of those. A
// binary that something installed depends on cannot be removed. A missing
// need is a warning, never an error: a computer is allowed to be incomplete,
// and the warning names the contract and the packages that fill it.

import type { DeloConfiguration } from "./draft";
import { deloBootsDinit, deloPathsOf, isDeloInstallable, parseDeloPipeline, type DeloFile, type DeloOption, type DeloOwnPipeline, type DeloPackage, type DeloRegistry } from "./registry";

export interface DeloPlan {
  configuration: DeloConfiguration;
  /** Binaries the change installs, dependencies first. */
  installed: string[];
  /** Binaries the change removes, in install order. */
  removed: string[];
  /** Options the change turns on, in registry order. */
  enabled: string[];
  /** Options the change turns off, in registry order. */
  disabled: string[];
  warnings: string[];
}

export function deloPackages(registry: DeloRegistry): DeloPackage[] {
  return registry.entries.filter(isDeloInstallable);
}

export function deloOptions(registry: DeloRegistry): DeloOption[] {
  return registry.entries.filter((entry) => entry.type === "option");
}

/** The options turned on in a computer, in registry order. */
export function deloEnabledOptions(registry: DeloRegistry, configuration: DeloConfiguration): string[] {
  return deloOptions(registry).map((entry) => entry.name).filter((name) => configuration.pipeline.enable.includes(name));
}

/** The binaries a computer installs, dependencies first: the ones its
 *  pipeline uses, the ones its options use, and theirs. Binaries that use
 *  each other in a cycle come in the order the walk reaches them. */
export function deloInstalled(registry: DeloRegistry, configuration: DeloConfiguration): DeloPackage[] {
  const packages = packageMap(registry);
  const options = optionMap(registry);
  const installed: DeloPackage[] = [];
  const seen = new Set<string>();
  const visit = (name: string) => {
    const entry = packages.get(name);
    if (entry === undefined || entry.type !== "binary") throw new Error(`${name} is not a registered binary`);
    if (seen.has(name)) return;
    seen.add(name);
    entry.use.forEach(visit);
    installed.push(entry);
  };
  configuration.pipeline.use.forEach(visit);
  for (const name of configuration.pipeline.enable) {
    const option = options.get(name);
    if (option === undefined) throw new Error(`${name} is not a registered option`);
    option.use.forEach(visit);
  }
  return installed;
}

/**
 * Plan `delo add <name>`. A binary already installed as a dependency joins
 * the pipeline's `use` and installs nothing. The first installed binary that
 * can be the first process starts a computer that has none.
 */
export function planDeloAdd(registry: DeloRegistry, configuration: DeloConfiguration, name: string): DeloPlan {
  const entry = packageMap(registry).get(name);
  if (entry === undefined) throw new Error(`${name} is not a registered binary or pipeline`);
  const { pipeline } = configuration;
  if (entry.type === "binary" && pipeline.use.includes(name)) throw new Error(`${name} is already installed`);
  if (entry.type === "pipeline" && configuration.added.includes(name)) throw new Error(`${name} is already added`);
  if (entry.type === "pipeline") refuseConflicts(registry, configuration, entry);

  const next = entry.type === "binary"
    ? { ...configuration, pipeline: { ...pipeline, use: [...pipeline.use, name] } }
    : { ...configuration, pipeline: merged(registry, pipeline, entry), added: [...configuration.added, name] };
  const before = deloInstalled(registry, configuration);
  const installed = deloInstalled(registry, next).filter((binary) => !before.includes(binary));
  const firstProcess = configuration.firstProcess
    ?? [...(entry.type === "binary" ? [entry] : []), ...installed].find((binary) => installed.includes(binary) && binary.provide.includes("init"))?.name
    ?? null;
  const enabled = turnedOn(registry, configuration, next);
  const options = optionMap(registry);
  const checked = [...installed, ...(entry.type === "pipeline" ? [entry] : []), ...enabled.map((option) => options.get(option)!)];
  return {
    configuration: { ...next, firstProcess },
    installed: installed.map((binary) => binary.name),
    removed: [],
    enabled,
    disabled: [],
    warnings: unmetNeeds(registry, checked, next),
  };
}

/** Plan `delo remove <name>`, and remove what only it kept. A name that
 *  starts with / is a path: every file of the pipeline at it goes. */
export function planDeloRemove(registry: DeloRegistry, configuration: DeloConfiguration, name: string): DeloPlan {
  if (name.startsWith("/")) {
    const { pipeline } = configuration;
    if (!pipeline.files.some((file) => file.to === name)) throw new Error(`the pipeline writes no file at ${name}`);
    return prune(registry, configuration, { ...configuration, pipeline: { ...pipeline, files: pipeline.files.filter((file) => file.to !== name) } });
  }
  if (configuration.added.includes(name)) throw new Error(`${name} is a pipeline the computer has a copy of. Remove its binaries one by one.`);
  const installed = deloInstalled(registry, configuration);
  if (!installed.some((entry) => entry.name === name)) throw new Error(`${name} is not installed`);
  const options = optionMap(registry);
  const dependents = [
    ...installed.filter((entry) => entry.use.includes(name)).map((entry) => `${entry.name} depends on ${name}. Remove ${entry.name} first.`),
    ...configuration.pipeline.enable.filter((option) => options.get(option)!.use.includes(name)).map((option) => `${option} depends on ${name}. Disable ${option} first.`),
  ];
  if (dependents.length > 0) throw new Error(dependents.join(" "));
  const { pipeline } = configuration;
  const next = { ...configuration, pipeline: { ...pipeline, use: pipeline.use.filter((used) => used !== name) } };
  const kept = deloInstalled(registry, next);
  const appended = pipeline.files.filter((file) => "content" in file).map((file) => file.to);
  const lost = installed.filter((entry) => !kept.includes(entry)).flatMap((entry) => {
    const paths = deloPathsOf(entry).filter((path) => appended.includes(path));
    return paths.length === 0 ? [] : [`The computer's pipeline adds to ${paths.join(" ")}, which ${entry.name} writes.`];
  });
  if (lost.length > 0) throw new Error(lost.join(" "));
  return prune(registry, configuration, next);
}

/** Plan `delo write`: put `file` in the pipeline, in place of the file at its
 *  path when there is one. Text on a path a binary writes as text is added
 *  to that file, which keeps its mode. */
export function planDeloWrite(registry: DeloRegistry, configuration: DeloConfiguration, file: DeloFile): DeloPlan {
  parseDeloPipeline({ files: [file] }, "the pipeline");
  const written = deloInstalled(registry, configuration).filter((entry) => deloPathsOf(entry).includes(file.to));
  const writers = written.map((entry) => entry.name);
  const text = written.every((entry) => entry.files.every((other) => other.to !== file.to || "content" in other));
  if ((!("content" in file) || !text) && writers.length > 0) throw new Error(`${writers.join(" ")} writes ${file.to}. Write another path, or remove ${writers.join(" ")}.`);
  if ("content" in file && file.mode !== undefined && writers.length > 0) throw new Error(`${writers.join(" ")} writes ${file.to}, which keeps its mode. Write it without a mode.`);
  const { pipeline } = configuration;
  const files = pipeline.files.some((written) => written.to === file.to)
    ? pipeline.files.map((written) => written.to === file.to ? file : written)
    : [...pipeline.files, file];
  const warnings = writers.length === 0 ? [] : [`${writers.join(" ")} writes ${file.to}: the content goes at the end of it.`];
  return { configuration: { ...configuration, pipeline: { ...pipeline, files } }, installed: [], removed: [], enabled: [], disabled: [], warnings };
}

/** Plan `delo enable <name>`: install its missing dependencies. An option
 *  never chooses the first process. */
export function planDeloEnable(registry: DeloRegistry, configuration: DeloConfiguration, name: string): DeloPlan {
  const options = optionMap(registry);
  const option = options.get(name);
  if (option === undefined) throw new Error(`${name} is not an option. Options: ${[...options.keys()].join(", ")}`);
  const { pipeline } = configuration;
  if (pipeline.enable.includes(name)) throw new Error(`${name} is already enabled`);

  const next = { ...configuration, pipeline: { ...pipeline, enable: inRegistryOrder(registry, [...pipeline.enable, name]) } };
  const before = deloInstalled(registry, configuration);
  const installed = deloInstalled(registry, next).filter((binary) => !before.includes(binary));
  return {
    configuration: next,
    installed: installed.map((binary) => binary.name),
    removed: [],
    enabled: [name],
    disabled: [],
    warnings: unmetNeeds(registry, [option, ...installed], next),
  };
}

/** Plan `delo disable <name>`, and remove what only it kept. */
export function planDeloDisable(registry: DeloRegistry, configuration: DeloConfiguration, name: string): DeloPlan {
  const { pipeline } = configuration;
  if (!pipeline.enable.includes(name)) throw new Error(`${name} is not enabled`);
  return prune(registry, configuration, { ...configuration, pipeline: { ...pipeline, enable: pipeline.enable.filter((enabled) => enabled !== name) } });
}

/** `pipeline` with a copy of `entry` merged into it. */
function merged(registry: DeloRegistry, pipeline: DeloOwnPipeline, entry: DeloPackage): DeloOwnPipeline {
  const union = (current: string[], added: string[]) => [...current, ...added.filter((name) => !current.includes(name))];
  return {
    ...pipeline,
    use: union(pipeline.use, entry.use),
    enable: inRegistryOrder(registry, union(pipeline.enable, entry.enable)),
    provide: union(pipeline.provide, entry.provide),
    need: union(pipeline.need, entry.need),
    device: union(pipeline.device, entry.device),
    files: [...pipeline.files, ...entry.files],
  };
}

/** Refuse a pipeline that writes a path the computer's pipeline or one of
 *  the binaries it would install already writes. Text is added to a text file there. */
function refuseConflicts(registry: DeloRegistry, configuration: DeloConfiguration, entry: DeloPackage): void {
  const binaries = deloInstalled(registry, { ...configuration, pipeline: { ...configuration.pipeline, use: [...configuration.pipeline.use, ...entry.use] } });
  const files = [...configuration.pipeline.files, ...binaries.flatMap((binary) => binary.files)];
  const taken = new Set(files.map((file) => file.to));
  const text = new Set(files.filter((file) => "content" in file).map((file) => file.to));
  const conflicts = entry.files.filter((file) => taken.has(file.to) && (!("content" in file) || !text.has(file.to))).map((file) => file.to);
  if (conflicts.length > 0) throw new Error(`${entry.name} writes ${conflicts.join(" ")}, which the computer already has`);
  const kept = new Set(binaries.flatMap(deloPathsOf));
  const modes = entry.files.filter((file) => "content" in file && file.mode !== undefined && kept.has(file.to)).map((file) => file.to);
  if (modes.length > 0) throw new Error(`${entry.name} writes ${modes.join(" ")} with a mode, but a binary writes it and it keeps its mode`);
}

const inRegistryOrder = (registry: DeloRegistry, names: string[]) =>
  deloOptions(registry).map((entry) => entry.name).filter((name) => names.includes(name));

/** The options `after` turns on that `before` did not. */
function turnedOn(registry: DeloRegistry, before: DeloConfiguration, after: DeloConfiguration): string[] {
  const was = deloEnabledOptions(registry, before);
  return deloEnabledOptions(registry, after).filter((option) => !was.includes(option));
}

/** The plan from `configuration` to `next`, which only takes things out:
 *  the binaries nothing keeps any more go, and so does a first process
 *  that went with them. */
function prune(registry: DeloRegistry, configuration: DeloConfiguration, next: DeloConfiguration): DeloPlan {
  const before = deloInstalled(registry, configuration);
  const after = deloInstalled(registry, next);
  const firstProcess = after.some((entry) => entry.name === configuration.firstProcess) ? configuration.firstProcess : null;
  const keepsInit = deloBootsDinit(next.pipeline) || after.some(deloBootsDinit);
  const startsNothing = firstProcess !== configuration.firstProcess
    ? [`${configuration.firstProcess} is the first process. The ${keepsInit ? "terminal" : "computer"} will have nothing to run.`]
    : [];
  const options = optionMap(registry);
  const enabled = deloEnabledOptions(registry, next);
  const checked = [...after, { name: "the computer's pipeline", need: next.pipeline.need }, ...enabled.map((option) => options.get(option)!)];
  return {
    configuration: { ...next, firstProcess },
    installed: [],
    removed: before.filter((entry) => !after.includes(entry)).map((entry) => entry.name),
    enabled: [],
    disabled: deloEnabledOptions(registry, configuration).filter((option) => !enabled.includes(option)),
    warnings: [...startsNothing, ...unmetNeeds(registry, checked, next)],
  };
}

function unmetNeeds(registry: DeloRegistry, checked: readonly Pick<DeloPackage, "name" | "need">[], configuration: DeloConfiguration): string[] {
  const filled = new Set([...configuration.pipeline.provide, ...deloInstalled(registry, configuration).flatMap((entry) => entry.provide)]);
  return checked.flatMap((entry) => entry.need
    .filter((need) => !filled.has(need))
    .map((need) => {
      const fillers = deloPackages(registry)
        .filter((candidate) => candidate.provide.includes(need))
        .map((candidate) => `delo add ${candidate.name}`);
      return `${entry.name} needs a ${need}. Add one: ${fillers.join(" or ")}`;
    }));
}

function packageMap(registry: DeloRegistry): Map<string, DeloPackage> {
  return new Map(deloPackages(registry).map((entry) => [entry.name, entry]));
}

function optionMap(registry: DeloRegistry): Map<string, DeloOption> {
  return new Map(deloOptions(registry).map((entry) => [entry.name, entry]));
}
