// The WebMCP tools of the delo page. Once the page has read the computers on
// this device, it registers with the browser's `document.modelContext` one
// `delo_<verb>` tool for each delo verb an agent runs. A tool runs the command
// a visitor types, so the page shows the same lines, and `delo_destroy`
// waits for the visitor's Y/N answer, as `delo_write` does before it
// replaces a file of another kind, and `delo_add` of a pipeline that turns
// options on. No tool turns on the `mcp` option, which accepts every WebMCP
// tool without asking the visitor. `delo_list` returns what the list view
// shows, and `delo_config` reads and changes what the settings view does, and
// lists a folder of the disk as the files pane does; uploads and downloads
// stay with people. Every result holds the lines the page shows and the
// computers the page lists. Results and errors use Kandelo's WebMCP envelope
// (see docs/webmcp.md).

import { guestPath, ToolError, type Schema } from "../../kandelo/webmcp/contract";
import { modelContextOf } from "../../kandelo/webmcp/model-context";
import { objectSchema, registerTool } from "../../kandelo/webmcp/registry";
import type { DeloChangeVerb, DeloFlag, DeloVerb } from "./command";
import type { DeloConfigChange, DeloConfigSubject, DeloPipelineChange } from "./config";
import type { DeloConfiguration } from "./draft";
import type { DeloFilesEntry } from "./files";
import { DELO_LIST_TABS } from "./list";
import { deloPathsOf, deloToolFilesOf, MAX_PIPELINE_DESCRIPTION_LENGTH, type DeloEntry, type DeloRegistry } from "./registry";
import { DELO_WRITE_FLAGS } from "./write";

interface DeloLine {
  label: string;
  text: string;
}

export interface DeloComputerSummary {
  name: string;
  state: string;
  /** Whether `configuration` waits for the next delo_run to reach the disk. */
  pending: boolean;
  /** Null for a computer Delo did not make. */
  configuration: DeloConfiguration | null;
  /** The image the computer boots, or null when Delo made it. */
  image: string | null;
}

/** What the tools reach of the delo page. */
export interface DeloPage {
  /** Run the command a visitor types, wait for its Y/N answer, and return the lines the page shows. */
  command(verb: DeloVerb, name: string | null, computer: string | null, flags?: DeloFlag[]): Promise<DeloLine[]>;
  computers(): DeloComputerSummary[];
  config(name: string, change: Partial<DeloConfigChange>, pipeline: Partial<DeloPipelineChange>): Promise<DeloConfigSubject>;
  /** The entries of `folder` on the disk of a stored computer, as the files pane lists them. */
  files(name: string, folder: string): Promise<DeloFilesEntry[]>;
}

type Args = Record<string, unknown>;

interface DeloTool {
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: Schema;
  run(page: DeloPage, registry: DeloRegistry, args: Args): Promise<Record<string, unknown>>;
}

const NAME_LENGTH = 4096;

const name = (description: string): Schema => ({ type: "string", description, maxLength: NAME_LENGTH });

const computer = name("The name of a computer on this device, as delo lists it.");

const TYPES = { binaries: "binary", pipelines: "pipeline", options: "option", images: "image", apps: "app" } as const;

const facts = (entry: DeloEntry): Record<string, unknown> => {
  if (entry.type === "image") return { vfs: entry.vfs, profile: entry.profile };
  if (entry.type === "app") return { url: entry.url };
  if (entry.type === "option") return { use: entry.use, need: entry.need };
  const shared = { files: deloPathsOf(entry), use: entry.use, provide: entry.provide, need: entry.need, device: entry.device, tools: deloToolFilesOf(entry) };
  if (entry.type === "binary") return shared;
  return { ...shared, enable: entry.enable };
};

/** The entries of one list view tab, with the facts its rows show. */
export function deloListEntries(registry: DeloRegistry, tab: typeof DELO_LIST_TABS[number]): Record<string, unknown>[] {
  return registry.entries.filter((entry) => entry.type === TYPES[tab]).map((entry) => ({ name: entry.name, description: entry.description, ...facts(entry) }));
}

const command = async (page: DeloPage, verb: DeloVerb, thing: unknown, target: unknown = null) => ({
  lines: await page.command(verb, (thing as string | undefined) ?? null, target as string | null),
  computers: page.computers(),
});

const text = (description: string): Schema => ({ type: "string", description, maxLength: 65536 });

/** The schema of each flag of `delo write` that is not free text. */
const FLAG_SCHEMA: Record<string, (description: string) => Schema> = {
  type: (description) => ({ type: "string", enum: ["file", "directory", "symlink"], description }),
  lazy: (description) => ({ type: "boolean", description: `true: ${description}.` }),
};

/** A file object of the registry, whose keys are the flags of `delo write`. */
const FILE: Schema = objectSchema({
  to: text("The absolute path of the file in the computer."),
  ...Object.fromEntries(Object.entries(DELO_WRITE_FLAGS).map(([key, description]) => [key, (FLAG_SCHEMA[key] ?? text)(description)])),
}, ["to"]);

/** The flags of `delo write` that `file` names: a true key is a flag alone, and a false key is no flag. */
const flagsOf = ({ to: _, ...keys }: Args): DeloFlag[] =>
  Object.entries(keys).filter(([, value]) => value !== false).map(([key, value]) => ({ key, value: value === true ? null : String(value) }));

const MCP = "mcp";

/** Refuse a change that turns on `mcp`: enabling it, or adding a pipeline that enables it. */
function refuseMcp(registry: DeloRegistry, verb: DeloChangeVerb, thing: unknown): void {
  const entry = registry.entries.find((candidate) => candidate.name === thing);
  const enables = verb === "enable" ? thing === MCP : verb === "add" && entry?.type === "pipeline" && entry.enable.includes(MCP);
  if (!enables) return;
  throw new ToolError("PERMISSION_DENIED", `An agent cannot turn on ${MCP}: it accepts every WebMCP tool without asking the visitor. The visitor can type delo ${verb} ${thing as string} <computer>.`);
}

const change = (verb: DeloChangeVerb, kind: string, description: string): DeloTool => ({
  name: `delo_${verb}`,
  description,
  readOnly: false,
  inputSchema: objectSchema({ name: name(`The ${kind} to ${verb}.`), computer }, ["name", "computer"]),
  run: async (page, registry, args) => {
    refuseMcp(registry, verb, args.name);
    return command(page, verb, args.name, args.computer);
  },
});

const named = (verb: DeloVerb, description: string): DeloTool => ({
  name: `delo_${verb}`,
  description,
  readOnly: false,
  inputSchema: objectSchema({ computer }, ["computer"]),
  run: (page, _, args) => command(page, verb, args.computer),
});

/** Every delo tool, in registration order. */
export const DELO_TOOLS: DeloTool[] = [
  {
    name: "delo_list",
    description: "List the entries of the delo registry of one kind, with what each one is, and the computers on this device. Binaries, pipelines and options go on a computer Delo makes; images open with delo_run; apps are links to deployments of their own.",
    readOnly: true,
    inputSchema: objectSchema({ tab: { type: "string", enum: [...DELO_LIST_TABS], description: "The kind of entry to list." } }, ["tab"]),
    run: async (page, registry, args) => ({ entries: deloListEntries(registry, args.tab as typeof DELO_LIST_TABS[number]), computers: page.computers() }),
  },
  {
    name: "delo_init",
    description: "Create a draft computer, the configuration of a computer that does not exist yet. The page holds one draft at a time, until delo_run builds it or the page reloads.",
    readOnly: false,
    inputSchema: objectSchema({ name: name("The draft's name; default a random name.") }, []),
    run: (page, _, args) => command(page, "init", args.name),
  },
  change("add", "binary or pipeline", "Add a binary, and what it requires, to a draft or to a computer Delo made, or copy a pipeline's binaries, options and files into the computer's own pipeline. A pipeline that turns options on is added once the visitor answers Y/N; the tool returns after the answer. A pipeline that turns on mcp is refused. A stored computer gets the change at its next delo_run."),
  change("remove", "binary or file", "Remove a binary, and what only it kept, from a draft or from a computer Delo made, or, for an absolute path, the file the computer's pipeline writes there. A copied pipeline is not a unit: remove its binaries and files one by one. A stored computer gets the change at its next delo_run."),
  {
    name: "delo_write",
    description: "Write one file into the pipeline of a draft or of a computer Delo made. On a path the pipeline already writes, only the given keys change. A file that replaces a file of another kind is written once the visitor answers Y/N; the tool returns after the answer. A stored computer gets the change at its next delo_run.",
    readOnly: false,
    inputSchema: objectSchema({ computer, file: FILE }, ["computer", "file"]),
    run: async (page, _, args) => {
      const file = args.file as Args;
      return { lines: await page.command("write", file.to as string, args.computer as string, flagsOf(file)), computers: page.computers() };
    },
  },
  change("enable", "option", "Enable an option on a draft or on a computer Delo made. mcp, which accepts every WebMCP tool without asking the visitor, is refused. A stored computer gets the change at its next delo_run."),
  change("disable", "option", "Disable an option on a draft or on a computer Delo made. A stored computer gets the change at its next delo_run."),
  {
    name: "delo_run",
    description: "Open a computer or an image. A draft that never ran is built into a draft computer first. A stored computer's pending changes are written to its disk first, which keeps every other file. The page then leaves for the computer, whose page registers the tools of its devices (device_*), of the registry's binaries (binary_*) and pipelines (pipeline_*), and of its other tool files (unofficial_*).",
    readOnly: false,
    inputSchema: objectSchema({ name: name("A computer on this device, an image delo_list names, or the http or https URL of an image.") }, ["name"]),
    run: (page, _, args) => command(page, "run", args.name),
  },
  named("save", "Save a draft computer, so it stays on this device until it is destroyed."),
  named("destroy", "Delete a draft or a computer from this device. The page asks the visitor Y/N first, and the tool returns once the visitor answers."),
  {
    name: "delo_config",
    description: "Read the settings of a draft or a computer, and rename it, change its description, or rename or describe its own pipeline when those are given. Only a computer Delo made has a description and an own pipeline. A stored computer's pipeline change waits for its next delo_run. With a folder, also list the entries of that folder on the stored computer's disk, as the files pane does; a draft has no disk.",
    readOnly: false,
    inputSchema: objectSchema({
      computer,
      name: name("The new name."),
      description: { type: "string", description: "The new description.", maxLength: 4096 },
      pipelineName: name("The new name of the computer's own pipeline: lowercase letters, digits, \".\", \"_\" and \"-\", not the name of a registry entry."),
      pipelineDescription: { type: "string", description: "The new description of the computer's own pipeline.", maxLength: MAX_PIPELINE_DESCRIPTION_LENGTH },
      folder: { type: "string", description: "An absolute folder on the computer's disk, such as /, whose entries the result lists.", maxLength: NAME_LENGTH },
    }, ["computer"]),
    run: async (page, _, args) => {
      const settings = await page.config(
        args.computer as string,
        { name: args.name as string | undefined, description: args.description as string | undefined },
        { name: args.pipelineName as string | undefined, description: args.pipelineDescription as string | undefined },
      );
      const files = args.folder === undefined ? {} : { files: await page.files(settings.name, guestPath(args.folder as string)) };
      return { settings, ...files, computers: page.computers() };
    },
  },
];

/** Register every delo tool for the life of the page. */
export function wireDeloTools(page: DeloPage, registry: DeloRegistry): void {
  const context = modelContextOf(document);
  if (context === null) return;
  const { signal } = new AbortController();
  for (const tool of DELO_TOOLS) {
    const definition = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: tool.readOnly, untrustedContentHint: true },
      execute: (args: Args) => tool.run(page, registry, args),
    };
    void Promise.resolve(registerTool(context, definition, signal)).catch((error) => console.error(`WebMCP: registering ${tool.name} failed`, error));
  }
}
