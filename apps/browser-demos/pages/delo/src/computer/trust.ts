// How far a delo computer trusts a tool file in /etc/mcp. A file is official
// when its path and text are a tool file of a registry binary or pipeline,
// which Delo reviewed. It is trusted when they are a tool file of the
// computer's own pipeline in its record on the host, which only the visitor
// changes. Any other file is untrusted: a guest program wrote it, it changed
// on the disk, or its text came from a URL or an archive. Every tool that is
// not official registers as `unofficial_<file name>`, so no file takes the
// name of an official or device tool. Until the visitor accepts an untrusted
// tool, the agent sees only text Delo writes: the file's description, its
// schema's descriptions and enum values never reach it, and a property name
// longer or richer than a short identifier hides the whole schema.

import type { Schema } from "../../../kandelo/webmcp/contract";
import { deloPackages } from "../packages";
import { deloToolWritesOf, type DeloPipeline, type DeloRegistry } from "../registry";

type DeloToolTrust = "official" | "trusted" | "untrusted";

/** The tool files a level of trust admits, by path and text. */
export type DeloToolTexts = ReadonlySet<string>;

const PROPERTY_NAME = /^[a-z][a-z0-9_]{0,31}$/;

const textKey = (path: string, text: string) => JSON.stringify([path, text]);

const textsOf = (pipelines: readonly DeloPipeline[]): DeloToolTexts =>
  new Set(pipelines.flatMap((pipeline) => deloToolWritesOf(pipeline.files).map((file) => textKey(file.to, file.content))));

/** The tool files of every registry binary and pipeline. */
export const officialToolTexts = (registry: DeloRegistry): DeloToolTexts =>
  textsOf(deloPackages(registry));

/** The tool files of the computer's own pipeline. */
export const trustedToolTexts = (pipeline: DeloPipeline): DeloToolTexts => textsOf([pipeline]);

export function deloToolTrust(path: string, text: string, official: DeloToolTexts, trusted: DeloToolTexts): DeloToolTrust {
  const key = textKey(path, text);
  if (official.has(key)) return "official";
  return trusted.has(key) ? "trusted" : "untrusted";
}

/** The name a tool file registers under: its own for an official file. */
export const deloToolName = (name: string, trust: DeloToolTrust) => trust === "official" ? name : `unofficial_${name}`;

/** The description an untrusted tool registers with until it is accepted. */
export const unacceptedDescription = (path: string, computer: string) =>
  `Unofficial tool from ${path} on the delo computer ${computer}. Calling it asks the user to accept it.`;

/** `schema` without its descriptions and enum values, or null when a property
 *  name is not a short identifier. */
export function unacceptedSchema(schema: Schema): Schema | null {
  const { description: _, enum: __, properties, additionalProperties, ...kept } = schema;
  const next: Schema = { ...kept };
  if (properties !== undefined) {
    const entries: [string, Schema][] = [];
    for (const [name, child] of Object.entries(properties)) {
      const stripped = PROPERTY_NAME.test(name) ? unacceptedSchema(child) : null;
      if (stripped === null) return null;
      entries.push([name, stripped]);
    }
    next.properties = Object.fromEntries(entries);
  }
  if (typeof additionalProperties === "object") {
    const stripped = unacceptedSchema(additionalProperties);
    if (stripped === null) return null;
    next.additionalProperties = stripped;
  } else if (additionalProperties !== undefined) {
    next.additionalProperties = additionalProperties;
  }
  return next;
}
