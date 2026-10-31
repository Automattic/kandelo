import type { InstalledPackageSessions, SessionOfferType } from "../../../../../web-libs/kandelo-session/src/package-sessions";

export function canLaunchLocally(type: SessionOfferType): boolean {
  const launch = type.launch;
  return !!launch && (launch.surface === "web" ? launch.host === "localhost"
    : !launch.args.some(argument => typeof argument === "object" && "field" in argument && argument.field === "network.host"));
}

export function installedActivityChoices(catalog: readonly InstalledPackageSessions[]) {
  return catalog.flatMap(entry => entry.manifest.offers
    .filter(type => !entry.clientOnly && !entry.unavailableOffers?.includes(type.id))
    .map(type => ({ entry, type, key: `${entry.manifest.package}/${type.id}` })))
    .sort((first, second) => first.type.title.localeCompare(second.type.title, "en", { sensitivity: "base" }) || first.key.localeCompare(second.key));
}

export function activityPorts(entry: InstalledPackageSessions, type: SessionOfferType): number[] {
  const join = entry.manifest.joins.find(join => join.id === type.join)?.launch;
  return join?.surface === "web" && join.host === "network.host" ? [join.port] : [];
}

export function activityConflicts(current: { identity: string; display: boolean; ports?: number[] }, next: { identity: string; display: boolean; ports?: number[] }): boolean {
  return current.identity === next.identity || current.display && next.display
    || !!current.ports?.some(port => next.ports?.includes(port));
}
