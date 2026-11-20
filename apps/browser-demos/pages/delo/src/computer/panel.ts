// A tool panel of the delo computer page: its button opens it above the
// toolbar and closes it again. One panel is open at a time.

let current: { close(): void } | null = null;

/** Wire `button` to `panel`. `opened` runs each time the panel opens and
 *  returns what to undo when it closes. */
export function wirePanel(button: HTMLButtonElement, panel: HTMLElement, opened: () => () => void = () => () => {}): void {
  let undo: (() => void) | null = null;
  const self = {
    close: () => {
      if (undo === null) return;
      undo();
      undo = null;
      panel.hidden = true;
      button.setAttribute("aria-pressed", "false");
      if (current === self) current = null;
    },
  };
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", () => {
    if (undo !== null) return self.close();
    current?.close();
    current = self;
    panel.hidden = false;
    button.setAttribute("aria-pressed", "true");
    undo = opened();
  });
}

export function closePanel(): void {
  current?.close();
}
