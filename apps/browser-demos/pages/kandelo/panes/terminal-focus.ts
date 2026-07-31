export interface TerminalAutoFocusRequest {
  autoFocus: boolean;
  container: HTMLElement;
  focusTerminal: () => void;
  isDisposed: () => boolean;
}

const USER_INPUT_OWNER = [
  "input:not([type='hidden'])",
  "textarea",
  "select",
  "iframe",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='textbox']",
  "[role='combobox']",
  "[role='searchbox']",
  "[role='spinbutton']",
].join(",");

/**
 * Focus xterm on its next animation frame unless another input surface
 * gained focus while the terminal was becoming ready.
 */
export function requestTerminalAutoFocus({
  autoFocus,
  container,
  focusTerminal,
  isDisposed,
}: TerminalAutoFocusRequest): number | null {
  if (!autoFocus) return null;

  return window.requestAnimationFrame(() => {
    if (isDisposed()) return;

    const activeElement = container.ownerDocument.activeElement;
    // WHY: PTY attachment can finish after someone starts editing the demo
    // script. Moving focus to xterm then redirects the rest of their input
    // into the guest, so late terminal readiness must respect that owner.
    if (userInputOwnsFocus(activeElement, container)) return;
    focusTerminal();
  });
}

function userInputOwnsFocus(
  activeElement: Element | null,
  terminalContainer: HTMLElement,
): boolean {
  if (activeElement === null || terminalContainer.contains(activeElement)) {
    return false;
  }
  return activeElement.closest(USER_INPUT_OWNER) !== null;
}
