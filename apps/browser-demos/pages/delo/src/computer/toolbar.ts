// The delo toolbar: a floating Kandelo button that unfolds into the bar, and
// the bar's fold button that turns it back into the floating button.

export function wireToolbar(fab: HTMLButtonElement, toolbar: HTMLElement, fold: HTMLButtonElement, folded: () => void): void {
  const unfold = (open: boolean) => {
    toolbar.hidden = !open;
    fab.hidden = open;
    fab.setAttribute("aria-expanded", String(open));
    (open ? fold : fab).focus();
    if (!open) folded();
  };
  fab.addEventListener("click", () => unfold(true));
  fold.addEventListener("click", () => unfold(false));
  toolbar.addEventListener("keydown", (event) => {
    if (event.key === "Escape") unfold(false);
  });
}
