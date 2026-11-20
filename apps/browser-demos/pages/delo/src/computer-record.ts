// What Delo knows about a computer it made. `delo.json`, in the computer's
// directory on the host, holds the truth: `disk`, the description and the
// configuration the disk was last written from, and `pending`, what add,
// remove, write, enable, disable and a new description changed since, or
// null: the next `delo run` writes it to the disk. Every disk build writes
// `disk` to /etc/delo/config.json, a copy guest programs read; Delo never
// reads it back, so nothing in the computer changes the record. `written`
// is what Delo wrote on that disk: each step and the paths it wrote, which
// the next build deletes or keeps by. config.json carries a copy of it too.
// A lost delo.json is not rebuilt. Kandelo never reads either file.

import { browserComputerDirectory } from "../../../../../host/src/browser-computer-storage";
import type { DeloConfiguration } from "./draft";
import { parseDeloOwnPipeline } from "./registry";

export const DELO_CONFIG_PATH = "/etc/delo/config.json";

/** A computer's description and configuration. */
export type DeloComputerConfig = { description: string } & DeloConfiguration;

/** One step of a disk: the step's files, and the package that wrote each path. */
interface DeloWrittenStep {
  text: string;
  claims: Record<string, string>;
}

/** What Delo wrote on a disk: every step by its path, and the directories removed steps left. */
export interface DeloWritten {
  steps: Record<string, DeloWrittenStep>;
  left: string[];
}

export interface DeloComputerRecord {
  version: 0;
  disk: DeloComputerConfig;
  written: DeloWritten;
  pending: DeloComputerConfig | null;
}

const FILE = "delo.json";
const MAX_BYTES = 4 * 1024 * 1024;
export const MAX_DESCRIPTION_LENGTH = 500;

/** A config in the key order config.json and delo.json store it. */
export const deloComputerConfig = (description: string, { pipeline, firstProcess, added }: DeloConfiguration): DeloComputerConfig =>
  ({ description, pipeline, firstProcess, added });

export function parseDeloComputerRecord(text: string): DeloComputerRecord {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.version !== 0 || Object.keys(value).length !== 4) {
    throw new Error("delo.json is invalid");
  }
  return {
    version: 0,
    disk: parseConfig(value.disk, "delo.json disk"),
    written: parseWritten(value.written),
    pending: value.pending === null ? null : parseConfig(value.pending, "delo.json pending"),
  };
}

const current = (record: DeloComputerRecord) => record.pending ?? record.disk;

/** The configuration add, remove, write, enable and disable change: the pending one, else the disk's. */
export const currentConfiguration = (record: DeloComputerRecord): DeloConfiguration => {
  const { description: _, ...configuration } = current(record);
  return configuration;
};

export const currentDescription = (record: DeloComputerRecord): string => current(record).description;

/** The record with `config` pending, or nothing pending when it is the disk's. */
const withConfig = (record: DeloComputerRecord, config: DeloComputerConfig): DeloComputerRecord => ({
  ...record,
  pending: JSON.stringify(config) === JSON.stringify(record.disk) ? null : config,
});

export const withPending = (record: DeloComputerRecord, configuration: DeloConfiguration): DeloComputerRecord =>
  withConfig(record, deloComputerConfig(currentDescription(record), configuration));

export const withDescription = (record: DeloComputerRecord, description: string): DeloComputerRecord =>
  withConfig(record, deloComputerConfig(description, currentConfiguration(record)));

/** The record of the computer `id`, or null when the host has none. */
export async function readDeloComputerRecord(id: string): Promise<DeloComputerRecord | null> {
  let file: File;
  try {
    file = await (await (await browserComputerDirectory(id, false)).getFileHandle(FILE)).getFile();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
  if (file.size > MAX_BYTES) throw new Error(`delo.json exceeds ${MAX_BYTES} bytes`);
  return parseDeloComputerRecord(await file.text());
}

export async function writeDeloComputerRecord(id: string, record: DeloComputerRecord): Promise<void> {
  const text = `${JSON.stringify(record)}\n`;
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error(`delo.json would exceed ${MAX_BYTES} bytes`);
  parseDeloComputerRecord(text);
  const writer = await (await (await browserComputerDirectory(id, false)).getFileHandle(FILE, { create: true })).createWritable();
  try {
    await writer.write(text);
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
}

function parseConfig(value: unknown, field: string): DeloComputerConfig {
  if (!isRecord(value) || Object.keys(value).length !== 4) throw new Error(`${field} is invalid`);
  const { description, pipeline, firstProcess, added } = value;
  if (typeof description !== "string" || description.length > MAX_DESCRIPTION_LENGTH
    || (firstProcess !== null && typeof firstProcess !== "string")
    || !Array.isArray(added) || !added.every((name) => typeof name === "string")) {
    throw new Error(`${field} is invalid`);
  }
  return deloComputerConfig(description, { pipeline: parseDeloOwnPipeline(pipeline, `${field}.pipeline`), firstProcess, added });
}

function parseWritten(value: unknown): DeloWritten {
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((item) => typeof item === "string");
  const isStep = (step: unknown) => isRecord(step) && Object.keys(step).length === 2 && typeof step.text === "string"
    && isRecord(step.claims) && strings(Object.values(step.claims));
  if (!isRecord(value) || Object.keys(value).length !== 2 || !isRecord(value.steps) || !Object.values(value.steps).every(isStep) || !strings(value.left)) {
    throw new Error("delo.json written is invalid");
  }
  return value as unknown as DeloWritten;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
