import type { ActivityCategory } from "../../../../../web-libs/kandelo-session/src/demo-config";
import type { ImageActivity } from "../../../../../web-libs/kandelo-session/src/image-activities";
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

/** Image authors link a local activity to its installed network recipe. */
export function activityCatalog(images: readonly ImageActivity[], packages: readonly InstalledPackageSessions[]) {
  const choices = installedActivityChoices(packages);
  const byKey = new Map(choices.map(choice => [choice.key, choice]));
  const linked = new Set<string>();
  const rows: {
    id: string; title: string; summary: string;
    category: ActivityCategory;
    image?: typeof images[number]; choice?: typeof choices[number];
  }[] = images.filter(image => !image.hidden).map(image => {
    const choice = image.share === undefined ? undefined : byKey.get(image.share);
    if (choice) linked.add(choice.key);
    return { id: `image/${image.id}`, title: image.title, summary: image.summary,
      category: image.category ?? "apps", image, choice };
  });
  for (const choice of choices) if (!linked.has(choice.key)) rows.push({
    id: choice.key, title: choice.type.title, summary: choice.type.description,
    category: choice.type.category ?? "apps", choice,
  });
  return rows.sort((first, second) => first.title.localeCompare(second.title, "en", { sensitivity: "base" }) || first.id.localeCompare(second.id));
}
