// The settings view `delo config <name>` opens in place of the delo input. A
// sidebar switches between five panes: the settings of one computer, which the
// visitor edits, then its pipeline, the files of its disk (see files-pane.ts),
// its binaries and its options, which only the delo verbs change. A binary
// opens to the same facts the registry view shows. The pipeline pane edits
// the name and description of the computer's own pipeline, and shows the
// facts the registry view shows for a pipeline, and the registered pipelines
// copied into it. Save, below the settings and the pipeline panes, writes
// every change of both once their names are valid, and closes the view;
// Cancel, the close button and Escape write nothing. The view builds the
// DOM; the page decides what the settings mean and where they are stored.

import { MAX_DESCRIPTION_LENGTH } from "./computer-record";
import type { DeloConfiguration } from "./draft";
import type { DeloFilesPane } from "./files-pane";
import { deloEntryFacts, deloEntryList, deloFactSections } from "./list";
import { deloInstalled, deloOptions } from "./packages";
import { MAX_PIPELINE_DESCRIPTION_LENGTH, type DeloRegistry } from "./registry";
import { element, renderDeloView } from "./view";

export interface DeloConfigSubject {
  name: string;
  /** Null for a computer with no delo record on this device. */
  description: string | null;
  state: string;
  /** Null for a computer Delo did not make. */
  configuration: DeloConfiguration | null;
  /** The account the first process runs as, or null when nothing runs. */
  user: string | null;
  /** The title of the image a computer Delo did not make started from. */
  startedFrom: string | null;
  createdAt: number | null;
  lastOpenedAt: number | null;
}

export interface DeloConfigChange {
  name: string;
  description: string | null;
}

export interface DeloPipelineChange {
  name: string;
  description: string;
}

interface DeloConfigHandlers {
  /** Why `name` cannot be the new name, or null when it can. */
  problem: (name: string) => string | null;
  save: (change: DeloConfigChange) => Promise<void>;
  /** Why `name` cannot be the pipeline's new name, or null when it can. */
  pipelineProblem: (name: string) => string | null;
  savePipeline: (change: DeloPipelineChange) => Promise<void>;
  close: () => void;
}

const date = (time: number) => new Date(time).toLocaleString();

const NOT_MADE = "delo did not make this computer";

const settingsFacts = (subject: DeloConfigSubject): [string, string[]][] => {
  const facts: [string, string[]][] = [];
  if (subject.configuration !== null) facts.push(["first process", [subject.configuration.firstProcess ?? "nothing"]]);
  if (subject.user !== null) facts.push(["user", [subject.user]]);
  if (subject.startedFrom !== null) facts.push(["started from", [subject.startedFrom]]);
  if (subject.createdAt !== null) facts.push(["created", [date(subject.createdAt)]]);
  if (subject.lastOpenedAt !== null) facts.push(["last opened", [date(subject.lastOpenedAt)]]);
  return facts;
};

const pane = (content: HTMLElement) => {
  const node = element("section", "");
  node.append(content);
  return node;
};

const binariesPane = (registry: DeloRegistry, { configuration }: DeloConfigSubject) => {
  if (configuration === null) return pane(element("p", "delo-view-note", `${NOT_MADE}, so it has no binaries delo knows`));
  const installed = deloInstalled(registry, configuration);
  return pane(installed.length === 0 ? element("p", "delo-view-note", "no binaries") : deloEntryList(installed));
};

const field = (label: string, input: HTMLElement) => {
  const node = element("label", "delo-config-field");
  node.append(element("span", "delo-view-key", label), input);
  return node;
};

/** The fields of one pane, which Save writes together with the other pane's. */
interface DeloFields<T> {
  inputs: HTMLElement[];
  problem: HTMLElement;
  value: () => T;
  changed: () => boolean;
}

const alert = () => {
  const node = element("p", "delo-config-problem");
  node.setAttribute("role", "alert");
  return node;
};

const pipelinePane = ({ configuration }: DeloConfigSubject): { node: HTMLElement; fields: DeloFields<DeloPipelineChange> | null } => {
  if (configuration === null) return { node: pane(element("p", "delo-view-note", `${NOT_MADE}, so it has no pipeline delo knows`)), fields: null };
  const { pipeline, added } = configuration;
  const name = element("input", "delo-config-input");
  name.value = pipeline.name;
  name.autocomplete = "off";
  name.spellcheck = false;
  const problem = alert();
  const description = element("textarea", "delo-config-input");
  description.value = pipeline.description;
  description.maxLength = MAX_PIPELINE_DESCRIPTION_LENGTH;
  description.rows = 2;
  const node = element("section", "");
  node.append(field("name", name), problem, field("description", description), ...deloEntryFacts({ ...pipeline, type: "pipeline" }, [["copied from", added]]));
  const value = () => ({ name: name.value, description: description.value });
  return {
    node,
    fields: { inputs: [name, description], problem, value, changed: () => name.value !== pipeline.name || description.value !== pipeline.description },
  };
};

const optionsPane = (registry: DeloRegistry, { configuration }: DeloConfigSubject) => {
  if (configuration === null) return pane(element("p", "delo-view-note", `${NOT_MADE}, so it has no options delo knows`));
  const enabled = deloOptions(registry).filter((entry) => configuration.pipeline.enable.includes(entry.name));
  return pane(enabled.length === 0 ? element("p", "delo-view-note", "no options") : deloEntryList(enabled));
};

/** `files` is the files pane, or why the computer has none. Returns whether a field holds a change Save has not written. */
export function renderDeloConfig(view: HTMLElement, registry: DeloRegistry, subject: DeloConfigSubject, files: DeloFilesPane | string, handlers: DeloConfigHandlers): () => boolean {
  const settings = element("section", "");
  const name = element("input", "delo-config-input");
  name.value = subject.name;
  name.autocomplete = "off";
  name.spellcheck = false;
  const problem = alert();
  settings.append(field("title", name), problem);

  const description = element("textarea", "delo-config-input");
  if (subject.description === null) {
    settings.append(element("p", "delo-view-note", `${NOT_MADE}, so it has no description`));
  } else {
    description.value = subject.description;
    description.maxLength = MAX_DESCRIPTION_LENGTH;
    description.rows = 2;
    settings.append(field("description", description));
  }
  settings.append(...deloFactSections(settingsFacts(subject)));
  const own: DeloFields<DeloConfigChange> = {
    inputs: subject.description === null ? [name] : [name, description],
    problem,
    value: () => ({ name: name.value, description: subject.description === null ? null : description.value }),
    changed: () => name.value !== subject.name || (subject.description !== null && description.value !== subject.description),
  };

  const status = element("span", "delo-config-status");
  status.setAttribute("aria-live", "polite");
  const pipeline = pipelinePane(subject);
  const category = element("span", `delo-label is-${subject.state}`, subject.state);

  const saves: HTMLButtonElement[] = [];
  const buttons = () => {
    const save = element("button", "delo-files-action", "save");
    const cancel = element("button", "delo-files-action", "cancel");
    save.type = "button";
    cancel.type = "button";
    save.disabled = true;
    save.addEventListener("click", () => { void persist(); });
    cancel.addEventListener("click", handlers.close);
    saves.push(save);
    return [save, cancel];
  };

  renderDeloView(view, {
    title: subject.name,
    panes: [
      { label: "settings", node: settings, actions: buttons() },
      { label: "pipeline", node: pipeline.node, ...(pipeline.fields === null ? {} : { actions: buttons() }) },
      { label: "binaries", node: binariesPane(registry, subject) },
      typeof files === "string"
        ? { label: "files", node: pane(element("p", "delo-view-note", files)) }
        : { label: "files", node: files.node, status: files.status, aside: files.aside, actions: files.actions, onShow: files.open },
      { label: "options", node: optionsPane(registry, subject) },
    ],
    shown: "settings",
    named: true,
    aside: [status, category],
    close: handlers.close,
  });

  const changed = () => own.changed() || pipeline.fields?.changed() === true;
  const showPane = (label: string) => view.querySelector<HTMLButtonElement>(`.delo-view-tab[aria-label="${label}"]`)!.click();

  const persist = async () => {
    const next = own.value();
    const nextPipeline = pipeline.fields?.value();
    problem.textContent = next.name === subject.name ? "" : handlers.problem(next.name) ?? "";
    if (pipeline.fields !== null) pipeline.fields.problem.textContent = nextPipeline!.name === subject.configuration!.pipeline.name ? "" : handlers.pipelineProblem(nextPipeline!.name) ?? "";
    if (problem.textContent !== "") return showPane("settings");
    if (pipeline.fields !== null && pipeline.fields.problem.textContent !== "") return showPane("pipeline");
    for (const save of saves) save.disabled = true;
    status.textContent = "";
    try {
      if (own.changed()) await handlers.save(next);
      if (nextPipeline !== undefined && pipeline.fields!.changed()) await handlers.savePipeline(nextPipeline);
      handlers.close();
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
      for (const save of saves) save.disabled = false;
    }
  };

  for (const fields of [own, ...pipeline.fields === null ? [] : [pipeline.fields]]) {
    for (const input of fields.inputs) {
      input.addEventListener("input", () => {
        fields.problem.textContent = "";
        for (const save of saves) save.disabled = !changed();
      });
    }
  }
  view.querySelector<HTMLElement>(".delo-view-tab[aria-current=page]")!.focus();
  return changed;
}
