/**
 * `demoSurfaceCaptureGate` — a `shouldCapture` predicate for
 * `BrowserInputSource` that scopes a running demo's DOM input capture to
 * the demo stage element (the app's `<main>` by default), so the
 * surrounding app chrome stays usable while a graphical demo runs.
 *
 * Without a gate, `BrowserInputSource` binds keyboard/wheel/pointer to
 * `window` and `preventDefault`s keyboard + wheel unconditionally, which
 * swallows scrolling and typing everywhere on the page — the "New" menu,
 * dialogs, and the rest of the React chrome stop responding while a demo
 * (sdl2, evdev) is active.
 *
 * The Kandelo demo DOM nests the demo's own surface inside the machine
 * primary slot, as a sibling of the terminal and Inspector surfaces, all
 * inside <main>; the dock and every pop-over render outside <main>:
 *   div.kapp
 *     ├── main.kmain
 *     │    └── … kmachine-primary-slot
 *     │         ├── div.kmodeset-surface   ← sdl2 (its canvas)
 *     │         ├── div.kshell-surface     ← terminal
 *     │         └── div.kinternals-surface ← Inspector / syslog
 *     ├── nav.kdock-shell                  ← dock (the "New" button)
 *     └── section.kdock-pane-*             ← the New menu / dialogs
 * so a caller should pass the demo's *own* surface (e.g.
 * `.kmodeset-surface`), not all of <main>: that releases not just the
 * out-of-<main> chrome (New menu, dialogs) but also the sibling terminal
 * and Inspector surfaces, which must stay scrollable/typable while a demo
 * runs. The demo surface stays mounted while the machine runs, even when
 * another primary view is shown, so this scoping holds across view
 * switches.
 *
 * Rules:
 *   - keyboard (keydown/keyup): capture unless focus moved to a control
 *     outside the demo surface (a New-menu button, a dialog field, the
 *     terminal, the Inspector). While the user just watches the demo,
 *     `document.activeElement` is the body (the canvas is not focusable),
 *     so keys keep flowing to the demo.
 *   - pointer/wheel: capture only when the event targets the demo
 *     surface, so a wheel over the New menu / terminal / Inspector scrolls
 *     that surface instead of being eaten.
 *
 * If no surface element is resolvable (the demo view is not mounted — e.g.
 * during boot before the pane mounts, or after a switch to another
 * primary view), the gate does NOT capture, so input goes to whatever
 * surface is actually active rather than a demo the user isn't looking at.
 */
export function demoSurfaceCaptureGate(
  getSurface: () => Element | null = () => document.querySelector("main"),
  getActiveElement: () => Element | null = () => document.activeElement,
  getBody: () => Element | null = () => document.body,
): (e: Event) => boolean {
  return (e: Event): boolean => {
    const surface = getSurface();
    if (!surface) return false;
    if (e.type === "keydown" || e.type === "keyup") {
      const active = getActiveElement();
      if (active === null) return true;
      if (active === getBody()) return true;
      return surface.contains(active);
    }
    // pointer* / wheel: spatially scoped to the stage. `contains` returns
    // false for a non-Node target (e.g. window), so no instanceof guard is
    // needed — and avoiding it keeps the gate testable without a DOM.
    const t = e.target as Node | null;
    return t !== null && surface.contains(t);
  };
}
