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
 * The Kandelo demo DOM separates the stage from the chrome:
 *   div.kapp
 *     ├── main.kmain               ← demo stage (canvas / terminal live here)
 *     ├── nav.kdock-shell          ← dock (the "New" button)
 *     └── section.kdock-pane-*      ← the New menu / dialogs (role="dialog")
 * The dock and every pop-over render *outside* `<main>`, so scoping
 * capture to `<main>` is enough to release the chrome.
 *
 * Rules:
 *   - keyboard (keydown/keyup): capture unless focus moved to a control
 *     outside the stage (e.g. a New-menu button or a dialog field). While
 *     the user just watches the demo, `document.activeElement` is the
 *     body (the stage canvas is not focusable), so keys keep flowing to
 *     the demo.
 *   - pointer/wheel: capture only when the event targets the stage, so a
 *     wheel over the New menu scrolls the menu instead of being eaten.
 *
 * If no stage element exists yet (attach can race the pane mounting),
 * the gate defaults to capturing so early input is not silently dropped.
 */
export function demoSurfaceCaptureGate(
  getSurface: () => Element | null = () => document.querySelector("main"),
  getActiveElement: () => Element | null = () => document.activeElement,
  getBody: () => Element | null = () => document.body,
): (e: Event) => boolean {
  return (e: Event): boolean => {
    const surface = getSurface();
    if (!surface) return true;
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
