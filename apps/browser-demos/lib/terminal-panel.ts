/**
 * TerminalPanel — collapsible bottom panel for hosting an xterm.js terminal.
 *
 * Provides the expand/collapse chrome (bar with toggle indicator, status text)
 * and a body container where PtyTerminal mounts xterm.js. Does not create
 * or manage the Terminal instance itself.
 */

export class TerminalPanel {
  private root: HTMLElement;
  private bar: HTMLElement;
  private toggleIndicator: HTMLElement;
  private statusEl: HTMLElement;
  private body: HTMLElement;
  private _expanded = false;
  private expandCallbacks: Array<() => void> = [];
  private handleBarClick: () => void;

  constructor(container: HTMLElement) {
    // Root element
    this.root = document.createElement("div");
    this.root.className = "terminal-panel";

    // Bar (clickable header)
    this.bar = document.createElement("div");
    this.bar.className = "terminal-panel-bar";

    // Toggle indicator (right-pointing triangle)
    this.toggleIndicator = document.createElement("span");
    this.toggleIndicator.className = "terminal-panel-toggle";
    this.toggleIndicator.textContent = "\u25B6"; // ▶

    // Label
    const label = document.createElement("span");
    label.className = "terminal-panel-label";
    label.textContent = "Terminal";

    // Status text (right-aligned)
    this.statusEl = document.createElement("span");
    this.statusEl.className = "terminal-panel-status";

    this.bar.appendChild(this.toggleIndicator);
    this.bar.appendChild(label);
    this.bar.appendChild(this.statusEl);

    // Body (where xterm.js mounts)
    this.body = document.createElement("div");
    this.body.className = "terminal-panel-body";

    this.root.appendChild(this.bar);
    this.root.appendChild(this.body);

    // Click handler
    this.handleBarClick = () => this.toggle();
    this.bar.addEventListener("click", this.handleBarClick);

    container.appendChild(this.root);
  }

  /** Returns the body div where PtyTerminal should mount xterm.js. */
  getTerminalContainer(): HTMLElement {
    return this.body;
  }

  /** Whether the panel is currently expanded. */
  get expanded(): boolean {
    return this._expanded;
  }

  /** Expand the panel, showing the terminal body. */
  expand(): void {
    if (this._expanded) return;
    this._expanded = true;
    this.root.classList.add("expanded");
    for (const cb of this.expandCallbacks) {
      cb();
    }
  }

  /** Collapse the panel, hiding the terminal body. */
  collapse(): void {
    if (!this._expanded) return;
    this._expanded = false;
    this.root.classList.remove("expanded");
  }

  /** Toggle between expanded and collapsed states. */
  toggle(): void {
    if (this._expanded) {
      this.collapse();
    } else {
      this.expand();
    }
  }

  /** Set status text displayed in the bar (e.g. "Shell ready"). */
  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  /** Register a callback that fires when the panel expands (useful for xterm fit). */
  onExpand(cb: () => void): void {
    this.expandCallbacks.push(cb);
  }

  /** Remove all DOM elements and event listeners. */
  dispose(): void {
    this.bar.removeEventListener("click", this.handleBarClick);
    this.expandCallbacks = [];
    this.root.remove();
  }
}
