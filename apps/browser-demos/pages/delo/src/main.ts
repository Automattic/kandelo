// The delo landing page: one input, one command, and the list of computers on
// this device. `delo init` creates a draft, the config of a computer that does
// not exist yet. `add`, `remove`, `write`, `enable` and `disable` change the
// configuration of the computer they name: a draft, or a stored computer Delo
// made, whose pending configuration is in its `delo.json` (see
// computer-record.ts). `delo write` puts
// a file in that configuration's pipeline, and asks Y/N before it replaces a
// file of another kind. A typed `delo write` that gives no source opens the
// file's text to edit (see editor.ts). `delo run` builds a
// draft into a temporary computer and opens it, or opens a stored computer, a
// registered image, or an image URL. A stored computer with a pending
// configuration gets it on its disk first, and keeps its data (see
// computer-image.ts). `delo save` keeps a temporary computer.
// `delo config` opens the settings of a computer, whose files pane shows the
// files of a stored computer Delo made, to download and upload them, or of a
// computer that boots an image, to download them.
// `delo destroy` deletes a draft or a stored computer once the visitor
// answers Y; that key never reaches the input. Options belong to the visitor:
// `delo add` of a pipeline that turns options on asks Y/N first. A share
// link (`?draft=`, see share.ts) opens the page with the draft it describes,
// once the visitor trusts it when it turns options on; a session link also
// makes `delo run` of that draft join its network session.
// The draft lives only in this page, so a reload of the page discards it. The
// registry is tracked here (registry.json) and parsed the way the gallery
// roster is: it fails loudly on a malformed file rather than showing a
// partial list.

import { BrowserComputerStore, hasOpfsRoot } from "../../../../../web-libs/kandelo-session/src/browser-computer-store";
import type { StoredComputer } from "../../../../../web-libs/kandelo-session/src/computer-library";
import { DELO_USAGE, DELO_VERBS, isDeloChangeVerb, isDeloVerb, parseDeloCommand, type DeloChangeVerb, type DeloFlag, type DeloVerb } from "./command";
import { completeDeloLine, type DeloArguments } from "./completion";
import { createDeloDraft, type DeloConfiguration, type DeloDraft } from "./draft";
import { deloEnabledOptions, deloInstalled, deloOptions, deloPackages, planDeloAdd, planDeloDisable, planDeloEnable, planDeloRemove, planDeloWrite, type DeloPlan } from "./packages";
import { DELO_WRITE_FLAGS, deloEditedFile, deloEditorFields, deloPipelineFile, deloWriteEdits, deloWriteOffers, deloWrittenFile } from "./write";
import { deloBootsDinit, deloImages, deloPipelineNameProblem, findDeloImage, parseDeloRegistry, type DeloFile, type DeloImage } from "./registry";
import { buildDeloImage } from "./computer-image-client";
import { deloComputerDescriptor } from "./computer-descriptor";
import { DELO_FIRST_PROCESS_ACCOUNT, deloAccountName } from "./account";
import { currentConfiguration, currentDescription, deloComputerConfig, readDeloComputerRecord, withDescription, withPending, writeDeloComputerRecord, type DeloComputerConfig, type DeloComputerRecord } from "./computer-record";
import { readStoredDisk } from "./stored-disk";
import { browserComputerStorageName } from "../../../../../host/src/browser-computer-storage";
import { acquireBrowserPersistenceComputerLease } from "../../../../../host/src/browser-persistence-computer-lease";
import { deloComputerUrl, deloImageOf, deloImageRunUrl, deloRunUrl } from "./machine-url";
import { sessionInvitation } from "../../../lib/network-session";
import { DELO_SHARE_PARAM, draftFromShare, sharedDraftName, withDeloSession, withoutDeloSession } from "./share";
import { renderDeloConfig, type DeloConfigChange, type DeloConfigSubject, type DeloPipelineChange } from "./config";
import { DELO_LIST_TABS, isDeloListTab, renderDeloList } from "./list";
import { renderDeloEditor } from "./editor";
import { deloFilesPane, type DeloFilesPane } from "./files-pane";
import { openDeloFilesDisk } from "./files-client";
import { deloComputerName, deloNameProblem, deloRandomName } from "./name";
import { wireDeloTools, type DeloComputerSummary } from "./webmcp";
import { ToolError } from "../../kandelo/webmcp/contract";
import registrySource from "./registry.json?raw";

const form = document.getElementById("delo-form");
const input = document.getElementById("delo-input");
const output = document.getElementById("delo-output");
const computerList = document.getElementById("delo-computers");
const menuList = document.getElementById("delo-menu");
const menu = menuList?.parentElement;
const stage = form?.parentElement;
const view = document.getElementById("delo-view");
if (!(form instanceof HTMLFormElement) || !(input instanceof HTMLInputElement) || !(output instanceof HTMLOutputElement) || !(computerList instanceof HTMLUListElement) || !(menuList instanceof HTMLUListElement) || !(menu instanceof HTMLDivElement) || !(stage instanceof HTMLDivElement) || !(view instanceof HTMLElement)) {
  throw new Error("The delo page is missing its form, input, output, computer list, menu, or settings element.");
}

const registry = parseDeloRegistry(registrySource);
const images = deloImages(registry);
const imageNames = images.map((entry) => entry.name);
const packages = deloPackages(registry);
const options = deloOptions(registry);
const store = new BrowserComputerStore();

const VERB_DETAIL: Record<DeloVerb, string> = {
  run: "open a computer or an image",
  list: "show the binaries, pipelines, options, images and apps",
  config: "open the settings and the files of a computer",
  init: "create a draft computer",
  save: "save a draft computer",
  destroy: "delete a draft or a saved computer",
  add: "add a binary or a pipeline to a computer",
  remove: "remove a binary or a file from a computer",
  write: "write a file into the pipeline of a computer",
  enable: "enable an option on a computer",
  disable: "disable an option on a computer",
};

let draft: DeloDraft | null = null;
/** The draft's description, which `delo run` writes into its config.json. */
let draftDescription = "";
/** The network session the draft joins when `delo run` opens it. */
let draftSession: { room: string; name: string } | null = null;
let computers: StoredComputer[] = [];
let records = new Map<string, DeloComputerRecord>();
/** Why the `delo.json` of a computer could not be read, by computer id. */
let unreadable = new Map<string, string>();
let storeError: string | null = null;
/** The command waiting for its Y/N answer: its verb, what N answers, what Y
 *  runs, and what settles `answered` once that is done. */
let pending: { verb: DeloVerb; declined: string; confirm: () => Promise<void>; settle: () => void } | null = null;
let answered: Promise<void> = Promise.resolve();
/** The line hint the output shows, until the next `show`. */
let hinted: Line | null = null;
/** The files pane of the open `delo config` view, which closing must close
 *  first. */
let filesPane: DeloFilesPane | null = null;
/** The path the open `delo write` view edits, until it saves. */
let editing: string | null = null;

/** The state Delo shows: the store's `temporary` retention reads as
 *  `draft`, like a draft that never ran: the state `delo save` changes. */
const state = (computer: StoredComputer) => computer.retention === "temporary" ? "draft" : computer.retention;

/** Every computer whose configuration Delo can change: the draft, then the
 *  stored computers Delo made. */
const targets = (): DeloDraft[] => [
  ...(draft === null ? [] : [draft]),
  ...computers.filter((computer) => records.has(computer.id))
    .map((computer) => ({ name: computer.title, ...currentConfiguration(records.get(computer.id)!) })),
];

const unique = (names: string[]) => [...new Set(names)];

const configurationOf = ({ name: _, ...configuration }: DeloDraft): DeloConfiguration => configuration;

const installedNames = (configuration: DeloConfiguration) => deloInstalled(registry, configuration).map((entry) => entry.name);

const writtenPaths = (configuration: DeloConfiguration) => configuration.pipeline.files.map((file) => file.to);

const argumentsByVerb = (): DeloArguments => ({
  run: [...(draft === null ? [] : [draft.name]), ...computers.map((computer) => computer.title), ...imageNames],
  list: DELO_LIST_TABS,
  init: [],
  save: computers.filter((computer) => computer.retention === "temporary").map((computer) => computer.title),
  config: [...(draft === null ? [] : [draft.name]), ...computers.map((computer) => computer.title)],
  destroy: [...(draft === null ? [] : [draft.name]), ...computers.map((computer) => computer.title)],
  add: packages.map((entry) => entry.name),
  remove: unique([...targets().flatMap(installedNames), ...targets().flatMap(writtenPaths)]),
  write: unique(targets().flatMap(writtenPaths)),
  enable: options.map((option) => option.name),
  disable: options.map((option) => option.name).filter((option) => targets().some((target) => target.pipeline.enable.includes(option))),
});

const accepts = (verb: DeloChangeVerb, thing: string, target: DeloDraft) => {
  if (verb === "add") return !target.pipeline.use.includes(thing) && !target.added.includes(thing);
  if (verb === "write") return true;
  if (verb === "remove") return [...installedNames(target), ...writtenPaths(target)].includes(thing);
  const enabled = target.pipeline.enable.includes(thing);
  return verb === "enable" ? !enabled : enabled;
};

const computersFor = (verb: DeloChangeVerb, thing: string) =>
  targets().filter((target) => accepts(verb, thing, target)).map((target) => target.name);

const flagsFor = (path: string, computer: string, flags: readonly DeloFlag[]) => {
  const target = targets().find((candidate) => candidate.name === computer);
  return target === undefined ? [] : deloWriteOffers(deloPipelineFile(target.pipeline, path), flags);
};

interface Line {
  label: string;
  text: string;
}

const row = (tag: "div" | "li", className: string, cells: [string, string][]) => {
  const element = document.createElement(tag);
  element.className = className;
  for (const [cellClass, text] of cells) {
    const cell = document.createElement("span");
    cell.className = cellClass;
    cell.textContent = text;
    element.append(cell);
  }
  return element;
};

/** The lines the output shows, and whether they are an error. */
let shown: { lines: Line[]; error: boolean } = { lines: [], error: false };

const LINE_MS = 2000;

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let rolling = 0;

let pointed = false;

const stopRolling = () => window.clearInterval(rolling);

output.addEventListener("pointerenter", () => pointed = true);
output.addEventListener("pointerleave", () => pointed = false);
output.addEventListener("wheel", stopRolling, { passive: true });
output.addEventListener("touchstart", stopRolling, { passive: true });

/** Scroll the output to its next line every LINE_MS, until its last line
 *  shows or the visitor scrolls it. The pointer on the output pauses it. */
const roll = () => {
  stopRolling();
  output.scrollTop = 0;
  const lines = [...output.children] as HTMLElement[];
  let index = 0;
  if (lines.length < 2) return;
  rolling = window.setInterval(() => {
    if (pointed) return;
    index += 1;
    output.scrollTo({ top: lines[index].offsetTop - lines[0].offsetTop, behavior: reducedMotion.matches ? "instant" : "smooth" });
    if (index === lines.length - 1) stopRolling();
  }, LINE_MS);
};

const show = (lines: Line[], error = false) => {
  hinted = null;
  shown = { lines, error };
  output.replaceChildren(...lines.map(({ label, text }) =>
    row("div", error ? "delo-line is-error" : "delo-line", [["delo-label", label], ["delo-text", text]])));
  roll();
};

const where = (entry: DeloImage) => `image · ${new URL(entry.vfs).host}`;

const describe = (configuration: DeloConfiguration) => {
  const installed = deloInstalled(registry, configuration);
  const running = [
    ...(deloBootsDinit(configuration.pipeline) || installed.some(deloBootsDinit) ? ["dinit"] : []),
    ...(configuration.firstProcess === null ? [] : [configuration.firstProcess]),
  ];
  const enabled = deloEnabledOptions(registry, configuration);
  return [
    running.length === 0 ? "nothing to run" : `runs ${running.join(" ")}`,
    installed.length === 0 ? "no packages" : installed.map((entry) => entry.name).join(" "),
    ...(enabled.length === 0 ? [] : [enabled.join(" ")]),
  ].join(" · ");
};

const imageOf = (computer: StoredComputer) => records.has(computer.id) ? null : deloImageOf(images, computer, window.location.href);

/** What a stored computer is: its configuration when Delo made it, its image
 *  when it boots one, else its own title. */
const describeStored = (computer: StoredComputer) => {
  const record = records.get(computer.id);
  return record === undefined ? imageOf(computer) ?? computer.descriptor.title : describe(currentConfiguration(record));
};

const renderComputers = () => {
  const rows = computers.map((computer) => {
    const problem = unreadable.get(computer.id);
    const cells: [string, string][] = [["delo-computer-name", computer.title], ["delo-text", problem ?? describeStored(computer)]];
    if (imageOf(computer) !== null) cells.push(["delo-text is-kind", "image"]);
    cells.push([`delo-label is-${state(computer)}`, state(computer)]);
    const computerRow = row("li", "delo-computer", cells);
    computerRow.classList.toggle("is-error", problem !== undefined);
    return computerRow;
  });
  if (draft !== null) {
    const draftRow = row("li", "delo-computer", [["delo-computer-name", draft.name], ["delo-text", describe(draft)], ["delo-label is-draft", "draft"]]);
    draftRow.classList.add("is-highlighted");
    rows.unshift(draftRow);
  }
  if (storeError !== null) {
    const errorRow = row("li", "delo-computer", [["delo-label", "error"], ["delo-text", `computers could not be read: ${storeError}`]]);
    errorRow.classList.add("is-error");
    rows.push(errorRow);
  }
  computerList.replaceChildren(...rows);
  computerList.hidden = rows.length === 0;
};

const refreshComputers = async () => {
  try {
    computers = (await store.list()).map((computer) => ({ ...computer, title: deloComputerName(computer.title) }));
    const next = new Map<string, DeloComputerRecord>();
    const failed = new Map<string, string>();
    for (const computer of computers) {
      try {
        const record = await readDeloComputerRecord(computer.id);
        if (record !== null) next.set(computer.id, record);
      } catch (err) {
        failed.set(computer.id, err instanceof Error ? err.message : String(err));
      }
    }
    records = next;
    unreadable = failed;
    storeError = null;
  } catch (err) {
    computers = [];
    records = new Map();
    unreadable = new Map();
    storeError = err instanceof Error ? err.message : String(err);
  }
  renderComputers();
};

const showIdle = () => show([{ label: "delo", text: "tab completes · enter runs" }]);

/** Turn the page's share link into the draft, once the visitor trusts it
 *  when it turns options on, and take the link out of the address bar so a
 *  reload does not create it again. */
const openShare = () => {
  const code = new URLSearchParams(window.location.search).get(DELO_SHARE_PARAM);
  if (code === null) return;
  const href = window.location.href;
  const url = new URL(withoutDeloSession(href));
  url.searchParams.delete(DELO_SHARE_PARAM);
  history.replaceState(history.state, "", url);
  try {
    const session = sessionInvitation(href);
    const shared = draftFromShare(registry, code);
    const name = sharedDraftName(shared.draft.name, computers.map((computer) => computer.title));
    const open = async () => {
      draft = { ...shared.draft, name };
      draftSession = session === null ? null : { room: session.room, name: session.name };
      show([
        { label: "init", text: `${name} computer created from a share link.` },
        ...(draftSession === null ? [] : [{ label: "network", text: `delo run ${name} joins the network session ${draftSession.name}.` }]),
        ...shared.warnings.map((text) => ({ label: "warning", text })),
      ]);
    };
    const { enable } = shared.draft.pipeline;
    if (enable.length === 0) void open();
    else ask("init", "trust this link and its options ?", "share link not opened.", open);
  } catch (err) {
    show([{ label: "error", text: err instanceof Error ? err.message : String(err) }], true);
  }
  renderComputers();
};

showIdle();
void refreshComputers().then(() => {
  stage.hidden = false;
  input.focus();
  openShare();
  wireDeloTools({ command, computers: summaries, config: configure, files: diskFiles }, registry);
});

window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  showIdle();
  void refreshComputers();
});

let candidates: string[] = [];
let prefix = "";
let active = 0;

const findComputer = (name: string): StoredComputer | null => {
  const matches = computers.filter((computer) => computer.title === name);
  if (matches.length > 1) throw new Error(`${matches.length} computers are named ${name}. Rename one in the app's computer library.`);
  return matches[0] ?? null;
};

const describeComputer = (name: string) => {
  if (draft?.name === name) return `draft · ${describe(draft)}`;
  const computer = computers.find((stored) => stored.title === name);
  if (computer === undefined) return null;
  return [state(computer), describeStored(computer), ...(imageOf(computer) === null ? [] : ["image"])].join(" · ");
};

const detail = (words: string[], candidate: string) => {
  const [verb, thing] = [words[1], words[2]];
  if (verb === "write" && candidate.startsWith("--")) return DELO_WRITE_FLAGS[candidate.slice(2)];
  if (!isDeloVerb(verb)) return isDeloVerb(candidate) ? VERB_DETAIL[candidate] : "";
  if (thing !== undefined && thing !== "") return describeComputer(candidate) ?? "";
  if (verb === "enable" || verb === "disable") return options.find((entry) => entry.name === candidate)?.description ?? "";
  if (verb === "add" || verb === "remove") return packages.find((entry) => entry.name === candidate)?.description ?? "";
  const computer = describeComputer(candidate);
  if (computer !== null) return computer;
  const entry = findDeloImage(registry, candidate);
  return entry === null ? "" : `${where(entry)} · ${entry.description}`;
};

const closeMenu = () => {
  candidates = [];
  menu.hidden = true;
  menuList.replaceChildren();
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
};

const highlight = (index: number) => {
  active = (index + candidates.length) % candidates.length;
  for (const [position, option] of [...menuList.children].entries()) {
    const selected = position === active;
    option.classList.toggle("is-active", selected);
    option.setAttribute("aria-selected", String(selected));
    if (selected) {
      input.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView({ block: "nearest" });
    }
  }
};

const RUN_HINT: Line = { label: "delo", text: "tab lists computers and images · enter on an image URL boots it" };

const TYPE_HINT: Line = { label: "type", text: "file · directory · symlink" };

/** Once the line changes, the result of the last command goes: the run hint
 *  shows while the line is a `delo run` before or in its one word, the type
 *  hint while the line is a `delo write` before or in the value of
 *  `--type`, and the idle line otherwise. */
const showLineHint = () => {
  const hint = /^\s*delo\s+run(\s+\S*)?\s*$/.test(input.value) ? RUN_HINT
    : /^\s*delo\s+write\s.*\s--type\s+\S*$/.test(input.value) ? TYPE_HINT
    : null;
  if (hint === null) return showIdle();
  if (hinted === hint) return;
  show([hint]);
  hinted = hint;
};

const accept = () => {
  input.value = `${prefix}${candidates[active]}`;
  closeMenu();
  showLineHint();
};

const openMenu = (next: string[], nextPrefix: string) => {
  candidates = next;
  prefix = nextPrefix;
  const words = nextPrefix.split(" ");
  menuList.replaceChildren(...next.map((candidate, index) => {
    const option = row("li", "delo-option", [["delo-option-name", candidate], ["delo-option-detail", detail(words, candidate)]]);
    option.id = `delo-option-${index}`;
    option.setAttribute("role", "option");
    option.addEventListener("mousedown", (event) => event.preventDefault());
    option.addEventListener("mousemove", () => highlight(index));
    option.addEventListener("click", () => {
      highlight(index);
      accept();
    });
    return option;
  }));
  menu.hidden = false;
  input.setAttribute("aria-expanded", "true");
  highlight(0);
};

input.addEventListener("keydown", (event) => {
  if (pending !== null && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    answer(pending, event.key.toLowerCase());
    return;
  }
  if (candidates.length > 0) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      highlight(active + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      accept();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      return;
    }
  }
  if (event.key !== "Tab") return;
  event.preventDefault();
  const completion = completeDeloLine(input.value, argumentsByVerb(), computersFor, flagsFor);
  input.value = completion.line;
  showLineHint();
  if (completion.candidates.length > 0) openMenu(completion.candidates, completion.prefix);
});

input.addEventListener("input", () => {
  closeMenu();
  showLineHint();
});
input.addEventListener("blur", closeMenu);

/** A click on the page that lands on nothing interactive, and selects no
 *  text, puts the cursor back in the input while it is shown. */
document.addEventListener("click", (event) => {
  if (stage.hidden) return;
  if (event.target instanceof Element && event.target.closest("a, button, input, select, textarea, label, summary, [tabindex], [role=option]")) return;
  if (document.getSelection()?.isCollapsed === false) return;
  input.focus();
});

/** Escape closes `delo list`, `delo config` and `delo write` as their close button does,
 *  unless the files pane's replace question takes it as its N first. */
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || view.hidden) return;
  event.preventDefault();
  history.back();
});

type OfferVerb = Exclude<DeloVerb, "init" | "list">;

const EMPTY_OFFER: Record<OfferVerb, string> = {
  run: "there is nothing to run",
  save: "there is no draft computer to save",
  config: "there is no computer to configure",
  destroy: "there is no computer to destroy",
  add: "the registry has no binaries or pipelines",
  remove: "no computer has a binary or a file",
  write: "no computer's pipeline writes a file yet · type delo write <path> <computer>",
  enable: "there is no option",
  disable: "no computer has an option enabled",
};

const offer = (verb: OfferVerb) => {
  const list = argumentsByVerb()[verb];
  if (list.length === 0) {
    show([{ label: "error", text: EMPTY_OFFER[verb] }], true);
    return;
  }
  openMenu([...list], `delo ${verb} `);
};

const offerComputers = (verb: DeloChangeVerb, thing: string) => {
  const list = computersFor(verb, thing);
  if (list.length === 0) {
    show([{ label: "error", text: `no computer accepts delo ${verb} ${thing}` }], true);
    return;
  }
  openMenu(list, `delo ${verb} ${thing} `);
};

const warningLines = (warnings: string[]): Line[] => warnings.map((text) => ({ label: "warning", text }));

/** Leave for `url` once the current task ends, so a tool's result reaches
 *  the agent before the page goes. */
const leave = (url: string) => window.setTimeout(() => window.location.assign(url), 0);

const runDraft = async (current: DeloDraft) => {
  show([{ label: "build", text: `${current.name} · ${describe(current)}` }]);
  const config = deloComputerConfig(draftDescription, configurationOf(current));
  const { image, written } = await buildDeloImage(registry, current.name, config);
  const computer = await store.create(deloComputerDescriptor(current.name), "temporary", null, current.name, image);
  await writeDeloComputerRecord(computer.id, { version: 0, disk: config, written, pending: null });
  draft = null;
  await refreshComputers();
  show([{ label: "open", text: `${computer.title} · ${state(computer)}` }]);
  const url = deloComputerUrl(computer.id, window.location.href);
  leave(draftSession === null ? url : withDeloSession(url, draftSession.room, draftSession.name));
};

const run = async (name: string) => {
  if (draft?.name === name) return runDraft(draft);
  const computer = findComputer(name);
  if (computer !== null) {
    const record = await readDeloComputerRecord(computer.id);
    if (record?.pending != null) await writePending(computer, { ...record, pending: record.pending });
    show([{ label: "open", text: `${computer.title} · ${state(computer)}` }]);
    leave(deloComputerUrl(computer.id, window.location.href));
    return;
  }
  const entry = findDeloImage(registry, name);
  if (entry !== null) {
    show([{ label: "open", text: `${entry.name} · ${where(entry)}` }]);
    leave(deloRunUrl(entry, window.location.href));
    return;
  }
  if (registry.entries.some((app) => app.type === "app" && app.name === name)) throw new Error(`${name} is an app on its own deployment · open it from delo list apps`);
  const image = deloImageRunUrl(name, window.location.href);
  if (image === null) throw new Error(`${name} is not a computer, a registered image or an image URL · run delo run`);
  show([{ label: "open", text: `image · ${new URL(name).host}` }]);
  leave(image);
};

/** Write the pending configuration of `computer` onto its disk, which keeps
 *  its data, and make it the disk's configuration. */
const writePending = async (computer: StoredComputer, record: DeloComputerRecord & { pending: DeloComputerConfig }) => {
  const progress = (text: string) => show([{ label: "build", text: `${computer.title} · ${text}` }]);
  progress(describe(record.pending));
  const lease = await acquireBrowserPersistenceComputerLease(browserComputerStorageName(computer.id)).catch((err: unknown) => {
    throw /another tab/.test(String(err)) ? new Error(`${computer.title} is open in another tab. Close it, then run it.`) : err;
  });
  let disk: Awaited<ReturnType<typeof buildDeloImage>>;
  try {
    const image = await readStoredDisk(store, computer, lease, progress);
    progress("writing the pending configuration");
    disk = await buildDeloImage(registry, computer.title, record.pending, { image, written: record.written });
  } finally {
    await lease();
  }
  await store.replaceDisk(computer.id, disk.image);
  await writeDeloComputerRecord(computer.id, { ...record, disk: record.pending, written: disk.written, pending: null });
  await refreshComputers();
};

const init = (name: string | null) => {
  if (draft !== null) throw new Error(`${draft.name} is still a draft. Run it with delo run, or reload the page to discard it.`);
  const titles = computers.map((computer) => computer.title);
  const problem = name === null ? null : deloNameProblem(name, titles);
  if (problem !== null) throw new Error(problem);
  draft = createDeloDraft(name ?? deloRandomName(titles));
  draftDescription = "";
  draftSession = null;
  show([{ label: "init", text: `${draft.name} computer created.` }]);
};

const save = async (name: string) => {
  if (draft?.name === name) throw new Error(`${name} is a draft. Run it with delo run first, then save it.`);
  const computer = findComputer(name);
  if (computer === null) throw new Error(`${name} is not a computer on this device`);
  if (computer.retention === "saved") throw new Error(`${name} is already saved`);
  await store.update(computer.id, { retention: "saved" });
  await refreshComputers();
  show([{ label: "save", text: `${name} is saved. It stays on this device until you delete it.` }]);
};

/** The stored computer Delo made that `name` names, with its current record. */
const deloComputer = async (verb: DeloVerb, name: string) => {
  const computer = findComputer(name);
  if (computer === null) throw new Error(`${name} is not a computer on this device`);
  const record = await readDeloComputerRecord(computer.id);
  if (record === null) throw new Error(`${name} has no delo record on this device, so delo cannot ${verb} it`);
  return { computer, record };
};

const ask = (verb: DeloVerb, question: string, declined: string, confirm: () => Promise<void>) => {
  answered = new Promise((settle) => { pending = { verb, declined, confirm, settle }; });
  show([{ label: verb, text: `${question} (Y/N)` }]);
};

const answer = ({ verb, declined, confirm, settle }: NonNullable<typeof pending>, key: string) => {
  if (key !== "y" && key !== "n" && key !== "escape") return;
  pending = null;
  if (key !== "y") {
    show([{ label: verb, text: declined }]);
    settle();
    return;
  }
  confirm()
    .then(() => { input.value = ""; })
    .catch((err) => show([{ label: "error", text: err instanceof Error ? err.message : String(err) }], true))
    .finally(() => {
      renderComputers();
      settle();
    });
};

const destroy = (name: string) => {
  if (draft?.name !== name && findComputer(name) === null) throw new Error(`${name} is not a computer on this device`);
  ask("destroy", `confirm you want to destroy ${name} ?`, `${name} kept.`, () => destroyConfirmed(name));
};

const destroyConfirmed = async (name: string) => {
  if (draft?.name === name) {
    draft = null;
  } else {
    const computer = findComputer(name);
    if (computer === null) throw new Error(`${name} is not a computer on this device`);
    await store.remove(computer.id);
    await refreshComputers();
  }
  show([{ label: "destroy", text: `${name} destroyed.` }]);
};

const userOf = (configuration: DeloConfiguration | null) => configuration?.firstProcess == null
  ? null
  : deloAccountName([...deloInstalled(registry, configuration), configuration.pipeline], DELO_FIRST_PROCESS_ACCOUNT.uid);

const configSubject = async (name: string): Promise<DeloConfigSubject> => {
  if (draft?.name === name) {
    const configuration = configurationOf(draft);
    return { name, description: draftDescription, state: "draft", configuration, user: userOf(configuration), startedFrom: null, createdAt: null, lastOpenedAt: null };
  }
  const computer = findComputer(name);
  if (computer === null) throw new Error(`${name} is not a computer on this device`);
  const record = await readDeloComputerRecord(computer.id);
  const configuration = record === null ? null : currentConfiguration(record);
  return {
    name,
    description: record === null ? null : currentDescription(record),
    state: state(computer),
    configuration,
    user: userOf(configuration),
    startedFrom: record === null ? computer.descriptor.title : null,
    createdAt: computer.createdAt,
    lastOpenedAt: computer.lastOpenedAt,
  };
};

/** Apply the settings view's change to the draft, when `id` is null, or to
 *  the stored computer `id`: the title goes to the computer library, the
 *  description is pending until the next `delo run` writes it to the disk. */
const saveConfig = async (id: string | null, change: DeloConfigChange) => {
  if (id === null) {
    draft = { ...draft!, name: change.name };
    draftDescription = change.description ?? "";
    return;
  }
  if (computers.find((computer) => computer.id === id)?.title !== change.name) await store.update(id, { title: change.name });
  if (change.description !== null) {
    const record = await readDeloComputerRecord(id);
    if (record === null) throw new Error(`${change.name} has no delo record on this device, so it has no description`);
    await writeDeloComputerRecord(id, withDescription(record, change.description));
  }
  await refreshComputers();
};

/** Apply the pipeline pane's change to the pipeline of the draft, when `id`
 *  is null, or of the stored computer `id`, where it is pending until the
 *  next `delo run` writes it to the disk. */
const savePipeline = async (id: string | null, title: string, change: DeloPipelineChange) => {
  if (id === null) {
    draft = { ...draft!, pipeline: { ...draft!.pipeline, ...change } };
    return;
  }
  const record = await readDeloComputerRecord(id);
  if (record === null) throw new Error(`${title} has no delo record on this device, so it has no pipeline`);
  const configuration = currentConfiguration(record);
  await writeDeloComputerRecord(id, withPending(record, { ...configuration, pipeline: { ...configuration.pipeline, ...change } }));
  await refreshComputers();
};

/** What the open settings view saved, for the line the delo output shows when
 *  the view closes: null until the first save. */
let configured: { from: string; to: string } | null = null;

/** The computer the open settings view shows, and whether it holds a change
 *  Save has not written, for the line the delo output shows when the view
 *  closes: null for another view. */
let configuring: { name: string; changed: () => boolean } | null = null;

/** Open a view in place of the delo input, as a history entry, so the
 *  browser's Back closes it. */
const openView = (label: string, state: object) => {
  history.pushState(state, "");
  configured = null;
  configuring = null;
  closeMenu();
  stage.hidden = true;
  view.hidden = false;
  view.setAttribute("aria-label", label);
};

const closeView = () => {
  view.hidden = true;
  view.replaceChildren();
  stage.hidden = false;
  if (configured !== null) {
    const { from, to } = configured;
    show([{ label: "config", text: from === to ? `${to} saved.` : `${from} renamed to ${to}.` }]);
  } else if (configuring?.changed() === true) {
    show([{ label: "config", text: `${configuring.name} not saved.` }]);
  }
  renderComputers();
  input.focus();
};

/** The names another draft or computer holds than the one `id` names, or
 *  than the draft when `id` is null. */
const otherNames = (id: string | null) =>
  [...(draft === null || id === null ? [] : [draft.name]), ...computers.filter((computer) => computer.id !== id).map((computer) => computer.title)];

/** Why delo cannot read the disk of `name`, or null when it can. */
const noDisk = (name: string): string | null => {
  if (draft?.name === name) return `${name} is a draft, so it has no disk yet. Run it with delo run first.`;
  const computer = findComputer(name)!;
  if (!records.has(computer.id) && imageOf(computer) === null) return `delo did not make ${name} and it boots no image, so delo cannot read its disk`;
  return null;
};

/** The files pane of `name`, or why it has none. */
const filesOf = (name: string): DeloFilesPane | string => {
  const reason = noDisk(name);
  if (reason !== null) return reason;
  const computer = findComputer(name)!;
  return deloFilesPane(name, hasOpfsRoot(computer.descriptor), (onState) => openDeloFilesDisk(store, computer, onState));
};

/** The entries of `folder` on the disk of `name`, read the way the files pane reads them. */
const diskFiles = async (name: string, folder: string) => {
  const reason = noDisk(name);
  if (reason !== null) throw new ToolError("INVALID_ARGUMENT", reason);
  const disk = await openDeloFilesDisk(store, findComputer(name)!, () => {});
  try {
    return await disk.list(folder);
  } finally {
    await disk.close();
  }
};

const config = async (name: string) => {
  const subject = await configSubject(name);
  const id = draft?.name === name ? null : findComputer(name)!.id;
  const files = filesOf(name);
  openView("computer settings", { deloConfig: name });
  filesPane = typeof files === "string" ? null : files;
  const changed = renderDeloConfig(view, registry, subject, files, {
    problem: (next) => deloNameProblem(next, otherNames(id)),
    save: async (change) => {
      await saveConfig(id, change);
      configured = { from: name, to: change.name };
    },
    pipelineProblem: (next) => deloPipelineNameProblem(registry, next),
    savePipeline: async (change) => {
      const title = configured?.to ?? name;
      await savePipeline(id, title, change);
      configured = { from: configured?.from ?? name, to: title };
    },
    close: () => history.back(),
  });
  configuring = { name, changed };
};

const list = async (tab: string | null) => {
  if (tab !== null && !isDeloListTab(tab)) throw new Error(`${tab} is not a list: ${DELO_LIST_TABS.join(" ")}`);
  openView("registry", { deloList: tab });
  renderDeloList(view, registry, tab ?? DELO_LIST_TABS[0], () => history.back());
};

window.addEventListener("popstate", () => {
  if (view.hidden) return;
  const session = filesPane;
  filesPane = null;
  const cancelled = editing;
  editing = null;
  if (cancelled !== null) {
    closeView();
    return show([{ label: "write", text: `${cancelled} not written.` }]);
  }
  if (session === null) return closeView();
  session.close().then(
    () => { closeView(); },
    (err) => {
      closeView();
      show([{ label: "error", text: err instanceof Error ? err.message : String(err) }], true);
    },
  );
});

const PLAN: Record<Exclude<DeloChangeVerb, "write">, (configuration: DeloConfiguration, name: string) => DeloPlan> = {
  add: (configuration, name) => planDeloAdd(registry, configuration, name),
  remove: (configuration, name) => planDeloRemove(registry, configuration, name),
  enable: (configuration, name) => planDeloEnable(registry, configuration, name),
  disable: (configuration, name) => planDeloDisable(registry, configuration, name),
};

const change = (verb: Exclude<DeloChangeVerb, "write">, current: DeloDraft, name: string): { next: DeloDraft; lines: Line[]; enabled: string[] } => {
  const plan = PLAN[verb](configurationOf(current), name);
  const next = { name: current.name, ...plan.configuration };
  const pipeline = packages.find((entry) => entry.name === name)?.type === "pipeline";
  if (verb === "add" && pipeline) {
    return { next, lines: [{ label: "add", text: `${name} is copied into the pipeline of ${current.name}` }, ...warningLines(plan.warnings)], enabled: plan.enabled };
  }
  const lines: Line[] = [];
  if (verb === "remove" && name.startsWith("/")) lines.push({ label: "remove", text: `${name} from the pipeline of ${current.name}` });
  if (verb === "enable" || verb === "disable") lines.push({ label: verb, text: `${name} is ${verb}d on ${current.name}` });
  if (verb === "add" && plan.installed.length === 0) lines.push({ label: "add", text: `${name} is kept on its own now` });
  if (plan.installed.length > 0) lines.push({ label: "add", text: `${plan.installed.join(" ")} to ${current.name}` });
  if (plan.removed.length > 0) lines.push({ label: "remove", text: `${plan.removed.join(" ")} from ${current.name}` });
  if (verb !== "enable" && plan.enabled.length > 0) lines.push({ label: "enable", text: `${plan.enabled.join(" ")} enabled on ${current.name}` });
  if (verb !== "disable" && plan.disabled.length > 0) lines.push({ label: "disable", text: `${plan.disabled.join(" ")} disabled on ${current.name}` });
  if (next.firstProcess !== null && next.firstProcess !== current.firstProcess) {
    lines.push({ label: "init", text: `${next.firstProcess} is the first process` });
  }
  return { next, lines: [...lines, ...warningLines(plan.warnings)], enabled: plan.enabled };
};

/** The configuration of `target`, and how to keep a change of it: as the
 *  draft, or as the pending configuration of a stored computer. */
const changeable = async (verb: DeloChangeVerb, target: string) => {
  if (draft?.name === target) {
    return {
      current: draft,
      keep: async (next: DeloDraft, lines: Line[]) => {
        draft = next;
        show(lines);
      },
    };
  }
  const { computer, record } = await deloComputer(verb, target);
  return {
    current: { name: target, ...currentConfiguration(record) },
    keep: async (next: DeloDraft, lines: Line[]) => {
      const changed = withPending(record, configurationOf(next));
      await writeDeloComputerRecord(computer.id, changed);
      await refreshComputers();
      show(changed.pending === null ? lines : [...lines, { label: "pending", text: `delo run ${target} writes it to the disk` }]);
    },
  };
};

/** Apply a change, once the visitor answers Y when a pipeline turns options on. */
const changeComputer = async (verb: Exclude<DeloChangeVerb, "write">, name: string, target: string) => {
  const { current, keep } = await changeable(verb, target);
  const { next, lines, enabled } = change(verb, current, name);
  const confirm = () => keep(next, lines);
  if (verb === "add" && enabled.length > 0) return ask("add", `add ${name} and its options ?`, `${name} not added.`, confirm);
  return confirm();
};

/** Write a file, once the visitor answers Y when it replaces a file of
 *  another kind. A typed line that gives no source opens the editor
 *  instead. */
const writeComputer = async (path: string, target: string, flags: DeloFlag[], typed: boolean) => {
  const { current, keep } = await changeable("write", target);
  const existing = deloPipelineFile(current.pipeline, path);
  if (typed && deloWriteEdits(flags)) return editComputer(path, target, flags, existing);
  const write = deloWrittenFile(existing, path, flags);
  const confirm = async () => {
    const plan = planDeloWrite(registry, configurationOf(current), write.file);
    await keep({ name: target, ...plan.configuration }, [
      { label: "write", text: `${path} ${write.replaces ? "replaced in" : "written to"} the pipeline of ${target}` },
      ...warningLines(plan.warnings),
    ]);
  };
  if (!write.replaces) return confirm();
  ask("write", `confirm you want to replace ${path} on ${target} ?`, `${path} kept.`, confirm);
};

/** Open the editor on the file `delo write` writes at `path`, once the
 *  pipeline can hold a file there; Save writes the file its options describe. */
const editComputer = async (path: string, target: string, flags: DeloFlag[], existing: DeloFile | undefined) => {
  const fields = deloEditorFields(existing, flags);
  const planned = async (file: DeloFile) => {
    const { current, keep } = await changeable("write", target);
    return { keep, plan: planDeloWrite(registry, configurationOf(current), file) };
  };
  await planned(existing ?? { to: path, content: "" });
  openView("write", { deloWrite: path });
  editing = path;
  renderDeloEditor(view, { path, fields }, {
    save: async (edited) => {
      const { keep, plan } = await planned(deloEditedFile(path, edited));
      await keep({ name: target, ...plan.configuration }, [{ label: "write", text: `${path} written to the pipeline of ${target}` }, ...warningLines(plan.warnings)]);
      editing = null;
      history.back();
    },
    close: () => history.back(),
  });
};

const execute = async (verb: DeloVerb | null, name: string | null, computer: string | null, flags: DeloFlag[], typed = false) => {
  if (verb === null) return openMenu([...DELO_VERBS], "delo ");
  if (verb === "init") return init(name);
  if (verb === "list") return list(name);
  if (name === null) return offer(verb);
  if (verb === "run") return run(name);
  if (verb === "save") return save(name);
  if (verb === "destroy") return destroy(name);
  if (verb === "config") return config(name);
  if (!isDeloChangeVerb(verb)) throw new Error(DELO_USAGE);
  if (computer === null) return offerComputers(verb, name);
  if (verb === "write") return writeComputer(name, computer, flags, typed);
  return changeComputer(verb, name, computer);
};

/** Run a command for a WebMCP tool as the typed line runs it, and wait for
 *  its Y/N answer. */
const command = async (verb: DeloVerb, name: string | null, computer: string | null, flags: DeloFlag[] = []) => {
  if (pending !== null) throw new ToolError("NOT_READY", `delo ${pending.verb} waits for the visitor's Y/N answer.`);
  try {
    await execute(verb, name, computer, flags);
  } catch (err) {
    show([{ label: "error", text: err instanceof Error ? err.message : String(err) }], true);
    throw err;
  } finally {
    renderComputers();
  }
  if (pending !== null) {
    input.focus();
    await answered;
  }
  if (shown.error) throw new Error(shown.lines.map((line) => line.text).join("\n"));
  return shown.lines;
};

const summaries = (): DeloComputerSummary[] => [
  ...(draft === null ? [] : [{ name: draft.name, state: "draft", pending: false, configuration: configurationOf(draft), image: null }]),
  ...computers.map((computer) => {
    const record = records.get(computer.id);
    return { name: computer.title, state: state(computer), pending: record?.pending != null, configuration: record === undefined ? null : currentConfiguration(record), image: imageOf(computer) };
  }),
];

/** Read the settings of `name`, and apply `change` to them first when it
 *  holds a name or a description, as the settings view saves them. */
const configure = async (name: string, change: Partial<DeloConfigChange>, pipeline: Partial<DeloPipelineChange>) => {
  const settings = change.name !== undefined || change.description !== undefined;
  const pipelined = pipeline.name !== undefined || pipeline.description !== undefined;
  if (!settings && !pipelined) return configSubject(name);
  const subject = await configSubject(name);
  const id = draft?.name === name ? null : findComputer(name)!.id;
  const next = change.name ?? name;
  const problem = next === name ? null : deloNameProblem(next, otherNames(id));
  if (problem !== null) throw new ToolError("INVALID_ARGUMENT", problem);
  const own = subject.configuration?.pipeline;
  if (pipelined && own === undefined) throw new ToolError("INVALID_ARGUMENT", `delo did not make ${name}, so it has no pipeline delo knows`);
  const pipelineProblem = pipeline.name === undefined || pipeline.name === own?.name ? null : deloPipelineNameProblem(registry, pipeline.name);
  if (pipelineProblem !== null) throw new ToolError("INVALID_ARGUMENT", pipelineProblem);
  if (settings) await saveConfig(id, { name: next, description: change.description ?? subject.description });
  if (pipelined && own !== undefined) await savePipeline(id, next, { name: pipeline.name ?? own.name, description: pipeline.description ?? own.description });
  renderComputers();
  return configSubject(next);
};

form.addEventListener("submit", (event) => {
  event.preventDefault();
  let command;
  try {
    command = parseDeloCommand(input.value);
  } catch (err) {
    show([{ label: "error", text: err instanceof Error ? err.message : DELO_USAGE }], true);
    return;
  }
  execute(command.verb, command.name, command.computer, command.flags, true)
    .then(() => {
      if (candidates.length === 0 && pending === null) input.value = "";
    })
    .catch((err) => show([{ label: "error", text: err instanceof Error ? err.message : String(err) }], true))
    .finally(renderComputers);
});
