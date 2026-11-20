// A delo share link: the delo landing page with `?draft=<code>`, where the
// code is a computer's name, the name and description of its own pipeline,
// the registered pipelines copied into it, the binaries it uses, its options and its first process, as
// base64url JSON. Opening it creates a draft from the registry, the way
// `delo init`, `add` and `enable` would; nothing boots until `delo run`. The
// link carries names only, never files, so the registry decides every byte
// the computer gets, and a computer whose pipeline those names do not
// rebuild cannot be shared. The code is
// untrusted input: it is size-capped, versioned, and refused loudly when
// malformed. A network session link is a share link that also names the
// session: opening it creates the draft, and running that draft joins the
// session.

import { sessionLink } from "../../../lib/network-session";
import { createDeloDraft, type DeloDraft } from "./draft";
import { deloInstalled, planDeloAdd, planDeloEnable, type DeloPlan } from "./packages";
import { MAX_NAME_LENGTH } from "./name";
import { deloPipelineNameProblem, MAX_PIPELINE_DESCRIPTION_LENGTH, type DeloRegistry } from "./registry";

export const DELO_SHARE_PARAM = "draft";

const MAX_CODE_LENGTH = 4096;
const MAX_NAMES = 64;

interface DeloShare {
  version: 3;
  name: string;
  pipelineName: string;
  pipelineDescription: string;
  added: string[];
  use: string[];
  enable: string[];
  firstProcess: string | null;
}

/** The share link of `draft`, on the landing page at `landingHref`. Throws
 *  when the names the link carries do not rebuild the draft's pipeline. */
export function deloShareUrl(registry: DeloRegistry, draft: DeloDraft, landingHref: string): string {
  const share: DeloShare = { version: 3, name: draft.name, pipelineName: draft.pipeline.name, pipelineDescription: draft.pipeline.description, added: draft.added, use: draft.pipeline.use, enable: draft.pipeline.enable, firstProcess: draft.firstProcess };
  if (JSON.stringify(rebuilt(registry, share).draft.pipeline) !== JSON.stringify(draft.pipeline)) {
    throw new Error(`${draft.name} has a pipeline the registered names it was made from do not rebuild, so a share link cannot carry it`);
  }
  const bytes = new TextEncoder().encode(JSON.stringify(share));
  const code = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const url = new URL(landingHref);
  url.search = "";
  url.hash = "";
  url.searchParams.set(DELO_SHARE_PARAM, code);
  return url.href;
}

/** `href` with the parameters that name the network session `room`.
 *  Kandelo's session link keeps only a gallery machine's parameters, so a
 *  delo page copies the session parameters onto its own URL. */
export function withDeloSession(href: string, room: string, name: string): string {
  const url = new URL(href);
  for (const [key, value] of new URL(sessionLink(href, room, name)).searchParams) url.searchParams.set(key, value);
  return url.href;
}

/** `href` without the parameters that name a network session. */
export function withoutDeloSession(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("network");
  url.searchParams.delete("networkName");
  return url.href;
}

/** The draft a share code describes, built from `registry`. Throws for a
 *  malformed code and for a name the registry refuses. */
export function draftFromShare(registry: DeloRegistry, code: string): { draft: DeloDraft; warnings: string[] } {
  return rebuilt(registry, parseShare(code));
}

/** Copy the shared pipelines, add the shared binaries and enable the shared
 *  options, then keep exactly the binaries and options the share names. */
function rebuilt(registry: DeloRegistry, share: DeloShare): { draft: DeloDraft; warnings: string[] } {
  const problem = deloPipelineNameProblem(registry, share.pipelineName);
  if (problem !== null) throw new Error(`the share link's pipeline name is refused: ${problem}`);
  let { name: _, ...configuration } = createDeloDraft(share.name);
  configuration = { ...configuration, pipeline: { ...configuration.pipeline, name: share.pipelineName, description: share.pipelineDescription } };
  const warnings: string[] = [];
  const step = (plan: DeloPlan) => {
    configuration = plan.configuration;
    warnings.push(...plan.warnings);
  };
  for (const name of share.added) {
    if (registry.entries.find((entry) => entry.name === name)?.type !== "pipeline") throw new Error(`${name} is not a registered pipeline`);
    step(planDeloAdd(registry, configuration, name));
  }
  for (const name of share.use) if (!configuration.pipeline.use.includes(name)) step(planDeloAdd(registry, configuration, name));
  for (const name of share.enable) if (!configuration.pipeline.enable.includes(name)) step(planDeloEnable(registry, configuration, name));
  configuration = { ...configuration, pipeline: { ...configuration.pipeline, use: share.use, enable: share.enable }, firstProcess: share.firstProcess };
  if (share.firstProcess !== null && !deloInstalled(registry, configuration).some((entry) => entry.name === share.firstProcess)) {
    throw new Error(`the shared first process ${share.firstProcess} is not installed`);
  }
  return { draft: { name: share.name, ...configuration }, warnings };
}

/** The name a shared draft gets on a device whose computers have `titles`:
 *  `name` when it is free, then `<name>-shared`, `<name>-shared-2`, and so
 *  on, compared without case. The base is shortened so the name stays
 *  within 120 characters. */
export function sharedDraftName(name: string, titles: readonly string[]): string {
  const taken = new Set(titles.map((title) => title.toLowerCase()));
  for (let copy = 1; ; copy++) {
    const suffix = copy === 1 ? "" : copy === 2 ? "-shared" : `-shared-${copy - 1}`;
    const candidate = `${name.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function parseShare(code: string): DeloShare {
  if (code.length > MAX_CODE_LENGTH) throw new Error(`the share link exceeds ${MAX_CODE_LENGTH} characters`);
  let value: unknown;
  try {
    const binary = atob(code.replace(/-/g, "+").replace(/_/g, "/"));
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
  } catch {
    throw new Error("the share link is not a delo share link");
  }
  const names = (list: unknown) => Array.isArray(list) && list.length <= MAX_NAMES && list.every((item) => typeof item === "string");
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("the share link is invalid");
  const share = value as Record<string, unknown>;
  if (Object.keys(share).length !== 8 || share.version !== 3
    || typeof share.pipelineName !== "string"
    || typeof share.pipelineDescription !== "string" || share.pipelineDescription.length > MAX_PIPELINE_DESCRIPTION_LENGTH
    || typeof share.name !== "string" || share.name === "" || share.name.length > MAX_NAME_LENGTH || /\s/.test(share.name)
    || !names(share.added) || !names(share.use) || !names(share.enable)
    || (share.firstProcess !== null && typeof share.firstProcess !== "string")) {
    throw new Error("the share link is invalid");
  }
  return share as unknown as DeloShare;
}
