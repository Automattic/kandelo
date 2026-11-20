// The registry view `delo list [tab]` opens in place of the delo input: one
// pane per kind of registry entry. Each row shows the entry's name and opens to
// one labeled section per fact of the entry; the search keeps the rows whose
// name holds it. The tools a binary or pipeline adds are rows of their own,
// each opening to its description, inputs and command. The view only reads.

import { deloPathsOf, deloToolFilesOf, isDeloInstallable, type DeloEntry, type DeloRegistry, type DeloToolFile } from "./registry";
import { element, focusRow, icon, renderDeloView } from "./view";

export const DELO_LIST_TABS = ["pipelines", "binaries", "options", "images", "apps"] as const;

type DeloListTab = typeof DELO_LIST_TABS[number];

export function isDeloListTab(word: string): word is DeloListTab {
  return (DELO_LIST_TABS as readonly string[]).includes(word);
}

const TYPES: Record<DeloListTab, DeloEntry["type"]> = { binaries: "binary", pipelines: "pipeline", options: "option", images: "image", apps: "app" };

const section = (label: string, content: (Node | string)[]) => {
  const box = element("div", label === "description" ? "delo-list-box is-prose" : "delo-list-box");
  box.append(...content);
  const node = element("section", "delo-list-section");
  node.append(element("h3", "delo-list-label", label), box);
  if (box.querySelector(".delo-list-stop") !== null) return node;
  node.classList.add("delo-list-stop");
  node.tabIndex = -1;
  return node;
};

const lines = (values: string[]) => values.map((value) => element("div", "", value));

const link = (url: string) => {
  const node = element("a", "delo-list-link", url);
  node.href = url;
  return node;
};

const inputs = ({ inputSchema }: DeloToolFile) => {
  const required = inputSchema.required ?? [];
  const lines = Object.entries(inputSchema.properties ?? {}).map(([name, schema]) =>
    [`${name} (${schema.type}${required.includes(name) ? ", required" : ""})`, ...(schema.description === undefined ? [] : [schema.description])].join(": "));
  return lines.length === 0 ? ["no inputs"] : lines;
};

const tool = (entry: DeloToolFile) => {
  const toggle = element("button", "delo-list-tool delo-list-stop");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.append(element("span", "delo-list-name", entry.name), icon("chevron"));
  const details = element("div", "delo-list-tool-details");
  details.hidden = true;
  details.append(
    element("p", "delo-list-tool-description", entry.description),
    ...inputs(entry).map((line) => element("div", "", line)),
    element("code", "delo-list-tool-command", entry.command.join(" ")),
  );
  toggle.addEventListener("click", () => {
    const opened = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(opened));
    details.hidden = !opened;
  });
  const node = element("div", "");
  node.append(toggle, details);
  return node;
};

/** One labeled section for each fact, each a stop of the up and down arrows. */
export const deloFactSections = (facts: [string, string[]][]) => facts.map(([label, values]) => section(label, lines(values)));

/** The labeled sections of `entry`'s facts, without its description, each a
 *  stop of the up and down arrows. `more` adds facts after them. */
export const deloEntryFacts = (entry: DeloEntry, more: [string, string[]][] = []) => {
  const all: [string, (Node | string)[]][] = [];
  if (entry.type === "image") all.push(["image it boots", [link(entry.vfs)]], ["profile it starts", [entry.profile]]);
  if (entry.type === "app") all.push(["opens at", [link(entry.url)]]);
  if (isDeloInstallable(entry)) all.push(["files it adds", lines(deloPathsOf(entry))]);
  if (isDeloInstallable(entry) || entry.type === "option") all.push(["what it requires", lines(entry.use)], ["needs something that provides", lines(entry.need)]);
  if (isDeloInstallable(entry)) all.push(["what it provides", lines(entry.provide)], ["devices it opens", lines(entry.device)], ["options it enables", lines(entry.enable)]);
  if (isDeloInstallable(entry)) all.push(["tools it adds", deloToolFilesOf(entry).map(tool)]);
  all.push(...more.map(([label, values]): [string, (Node | string)[]] => [label, lines(values)]));
  return all.filter(([, content]) => content.length > 0).map(([label, content]) => section(label, content));
};

const sections = (entry: DeloEntry) => [section("description", [entry.description]), ...deloEntryFacts(entry)];

const row = (entry: DeloEntry) => {
  const toggle = element("button", "delo-list-row");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.append(element("span", "delo-list-name", entry.name), icon("chevron"));
  const details = element("div", "delo-list-details");
  details.hidden = true;
  details.append(...sections(entry));
  const item = element("li", "delo-list-entry");
  item.dataset.name = entry.name.toLowerCase();
  item.append(toggle, details);
  const open = (opened: boolean) => {
    toggle.setAttribute("aria-expanded", String(opened));
    details.hidden = !opened;
    if (!opened) return;
    for (const other of item.parentElement!.querySelectorAll<HTMLElement>(".delo-list-entry")) {
      if (other === item) continue;
      other.querySelector(".delo-list-row")!.setAttribute("aria-expanded", "false");
      other.querySelector<HTMLElement>(".delo-list-details")!.hidden = true;
    }
    (item.nextElementSibling ?? item).scrollIntoView({ block: "nearest" });
  };
  toggle.addEventListener("click", () => open(toggle.getAttribute("aria-expanded") !== "true"));
  toggle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const closed = toggle.getAttribute("aria-expanded") !== "true";
    if (event.key === "ArrowLeft" && closed) return toggle.closest(".delo-view-panel")?.querySelector<HTMLElement>(".delo-view-tab[aria-current=page]")?.focus();
    open(event.key === "ArrowRight");
  });
  return item;
};

/** The rows of `entries`, which open to the whole entry. The up and down
 *  arrows move between the rows and through the sections and tools of an
 *  open row; the left arrow goes from a section back to its row, and from a
 *  closed row to the sidebar. */
export function deloEntryList(entries: DeloEntry[]): HTMLUListElement {
  const list = element("ul", "delo-list");
  list.append(...entries.map(row));
  list.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (event.key === "ArrowLeft" && target.classList.contains("delo-list-stop")) {
      event.preventDefault();
      focusRow(target.closest(".delo-list-entry")!.querySelector<HTMLElement>(".delo-list-row")!);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const stops = [...list.querySelectorAll<HTMLElement>(".delo-list-entry:not([hidden]) > .delo-list-row, .delo-list-entry:not([hidden]) > .delo-list-details:not([hidden]) .delo-list-stop")];
    const next = stops.indexOf(document.activeElement as HTMLElement) + (event.key === "ArrowDown" ? 1 : -1);
    focusRow(stops[Math.min(Math.max(next, 0), stops.length - 1)]);
  });
  return list;
}

const pane = (registry: DeloRegistry, tab: DeloListTab) => {
  const node = element("section", "");
  const entries = registry.entries.filter((entry) => entry.type === TYPES[tab]);
  if (entries.length === 0) {
    node.append(element("p", "delo-view-note", `the registry has no ${tab}`));
    return node;
  }
  const list = deloEntryList(entries);
  const empty = element("p", "delo-view-note delo-list-empty", `no ${tab} match`);
  empty.hidden = true;
  node.append(list, empty);
  return node;
};

const filter = (view: HTMLElement, query: string) => {
  for (const item of view.querySelectorAll<HTMLElement>(".delo-list-entry")) item.hidden = !item.dataset.name!.includes(query);
  for (const empty of view.querySelectorAll<HTMLElement>(".delo-list-empty")) empty.hidden = empty.parentElement!.querySelector(".delo-list-entry:not([hidden])") !== null;
};

export function renderDeloList(view: HTMLElement, registry: DeloRegistry, shown: DeloListTab, close: () => void): void {
  const search = element("input", "delo-list-search");
  search.type = "search";
  search.placeholder = "search";
  search.setAttribute("aria-label", "search");
  search.addEventListener("input", () => filter(view, search.value.trim().toLowerCase()));
  search.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    view.querySelector<HTMLButtonElement>(".delo-view-pane:not([hidden]) .delo-list-entry:not([hidden]) .delo-list-row")?.focus();
  });
  renderDeloView(view, {
    title: "registry",
    panes: DELO_LIST_TABS.map((tab) => ({ label: tab, node: pane(registry, tab) })),
    shown,
    named: false,
    aside: [search],
    close,
  });
  view.querySelector<HTMLElement>(".delo-view-tab[aria-current=page]")!.focus();
}
