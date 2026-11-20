// The frame `delo config` and `delo list` open in place of the delo input: a
// title and a close button above a panel, whose sidebar switches between
// panes and folds to its icons, and optional actions below it. A pane may add
// its own status, its own items to the pane header and its own actions, which
// show while it does; the row of actions keeps its height while they hide, so
// the panel does not move. Each view fills the panes; the frame owns the
// layout. In the sidebar, the up and down arrows switch panes and the right arrow enters the shown pane.

export const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Focus `node` and scroll it just into view: a bare focus() centers a hidden row. */
export const focusRow = (node: HTMLElement) => {
  node.focus({ preventScroll: true });
  node.scrollIntoView({ block: "nearest" });
};

const PIPELINE_ICON = '<circle cx="4" cy="4" r="1.5"></circle><circle cx="12" cy="12" r="1.5"></circle><path d="M5.5 4h4a2 2 0 0 1 0 4h-3a2 2 0 0 0 0 4h4"></path>';

const ICONS: Record<string, string> = {
  settings: '<path d="M2.5 4.5h6"></path><path d="M11.5 4.5h2"></path><circle cx="10" cy="4.5" r="1.5"></circle><path d="M2.5 11.5h2"></path><path d="M7.5 11.5h6"></path><circle cx="6" cy="11.5" r="1.5"></circle>',
  images: '<path d="M8 2.5 13.5 5.5 8 8.5 2.5 5.5Z"></path><path d="m2.5 8.25 5.5 3 5.5-3"></path><path d="m2.5 11 5.5 3 5.5-3"></path>',
  apps: '<path d="M6.5 3.5h-3v9h9v-3"></path><path d="M9.5 3H13v3.5"></path><path d="M13 3 8 8"></path>',
  binaries: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"></rect><path d="m5 6.5 2 1.5-2 1.5"></path><path d="M8.5 10h2.5"></path>',
  pipelines: PIPELINE_ICON,
  pipeline: PIPELINE_ICON,
  options: '<path d="m2.5 4.5 1.5 1.5 3-3"></path><path d="M9.5 4.5h4"></path><path d="m2.5 11 1.5 1.5 3-3"></path><path d="M9.5 11h4"></path>',
  sidebar: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"></rect><path d="M6.5 3v10"></path>',
  chevron: '<path d="m6 4 4 4-4 4"></path>',
  parent: '<path d="m10 4-4 4 4 4"></path>',
  files: '<path d="M2.5 4.5v8h11v-6.5h-6l-1.5-1.5Z"></path>',
  content: '<path d="M4 2.5h5.5l2.5 2.5v8.5H4Z"></path><path d="M6 7.5h4"></path><path d="M6 10h4"></path>',
  type: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"></rect><circle cx="11.25" cy="4.75" r="2.25"></circle><path d="M4.75 9 7 13.5H2.5Z"></path><rect x="9" y="9" width="4.5" height="4.5" rx="1"></rect>',
  from: '<path d="M8 2.5v7"></path><path d="m5 6.5 3 3 3-3"></path><path d="M3 11.5v2h10v-2"></path>',
  lazy: '<circle cx="8" cy="8" r="5.5"></circle><path d="M8 5v3l2 1.5"></path>',
  mode: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"></rect><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"></path>',
  owner: '<circle cx="8" cy="5.5" r="2.5"></circle><path d="M3.5 13.5a4.5 4.5 0 0 1 9 0"></path>',
};

export const icon = (name: string) => {
  const node = element("span", "delo-view-icon");
  node.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
  return node;
};

interface DeloPane {
  label: string;
  node: HTMLElement;
  /** What the header shows before the close button while this pane shows. */
  status?: HTMLElement;
  /** What the pane header shows after the pane's label while this pane shows. */
  aside?: HTMLElement[];
  /** What the frame shows below the panel while this pane shows. */
  actions?: HTMLElement[];
  /** Called each time the pane shows. */
  onShow?: () => void;
}

interface DeloViewFrame {
  title: string;
  panes: DeloPane[];
  /** The label of the pane the view opens on. */
  shown: string;
  /** Whether the pane header starts with the shown pane's label. */
  named: boolean;
  /** What the pane header shows after the pane's label. */
  aside: HTMLElement[];
  /** What the frame shows below the panel. */
  actions?: HTMLElement[];
  close: () => void;
}

/** Fill `view` with the frame. */
export function renderDeloView(view: HTMLElement, frame: DeloViewFrame): void {
  const heading = element("h1", "delo-view-title", frame.title);
  const close = element("button", "delo-view-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "close");
  close.addEventListener("click", frame.close);
  const header = element("header", "delo-view-header");
  header.append(heading, ...frame.panes.flatMap((pane) => pane.status ?? []), close);

  const paneHeading = element("h2", "delo-view-heading");
  const paneHeader = element("div", "delo-view-pane-header");
  paneHeader.append(...(frame.named ? [paneHeading] : []), ...frame.panes.flatMap((pane) => pane.aside ?? []), ...frame.aside);

  const panel = element("div", "delo-view-panel");
  const sidebar = element("nav", "delo-view-sidebar");
  sidebar.setAttribute("aria-label", "sections");
  const tabs = frame.panes.map(({ label, node }, index) => {
    node.classList.add("delo-view-pane");
    node.setAttribute("aria-label", label);
    const tab = element("button", "delo-view-tab");
    tab.type = "button";
    tab.setAttribute("aria-label", label);
    tab.title = label;
    tab.append(icon(label), element("span", "delo-view-tab-label", label));
    tab.addEventListener("click", () => show(label));
    tab.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        [...node.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea")].find((target) => target.checkVisibility())?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const next = (index + (event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length;
      show(frame.panes[next].label);
      tabs[next].focus();
    });
    return tab;
  });
  const toggle = element("button", "delo-view-tab delo-view-toggle");
  toggle.type = "button";
  toggle.append(icon("sidebar"));
  const collapse = (collapsed: boolean) => {
    panel.classList.toggle("is-collapsed", collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", collapsed ? "Expand the sidebar" : "Collapse the sidebar");
    toggle.title = collapsed ? "Expand" : "Collapse";
  };
  toggle.addEventListener("click", () => collapse(!panel.classList.contains("is-collapsed")));
  sidebar.append(...tabs, toggle);
  const group = (items: HTMLElement[]) => {
    const node = element("div", "delo-view-action-group");
    node.append(...items);
    return node;
  };
  const groups = frame.panes.map((pane) => pane.actions === undefined ? null : group(pane.actions));
  const show = (shown: string) => {
    paneHeading.textContent = shown;
    frame.panes.forEach(({ label, node, status, aside }, index) => {
      node.hidden = label !== shown;
      for (const item of [...status === undefined ? [] : [status], ...aside ?? []]) item.hidden = label !== shown;
      groups[index]?.style.setProperty("visibility", label === shown ? "" : "hidden");
      if (label === shown) tabs[index].setAttribute("aria-current", "page");
      else tabs[index].removeAttribute("aria-current");
    });
    frame.panes.find((pane) => pane.label === shown)?.onShow?.();
  };

  const content = element("div", "delo-view-content");
  content.append(paneHeader, ...frame.panes.map(({ node }) => node));
  panel.append(sidebar, content);
  const shell = element("div", "delo-view-shell");
  shell.append(panel);
  const actions = element("div", "delo-view-actions");
  const paneActions = groups.filter((node) => node !== null);
  actions.append(...frame.actions === undefined ? [] : [group(frame.actions)], ...paneActions);
  view.replaceChildren(header, shell, ...(actions.childElementCount === 0 ? [] : [actions]));
  show(frame.shown);
  collapse(false);
}
