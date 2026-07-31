import { expect, test } from "@playwright/test";

const helperModuleUrl = "/pages/kandelo/panes/terminal-focus.ts";
const fixtureModuleUrl = "/test/fixtures/terminal-autofocus-fixture.ts";
const fixturePageUrl = "/test/fixtures/terminal-autofocus-fixture.html";

test("late PTY attachment cannot steal the demo editor", async ({ page }) => {
  await page.goto(fixturePageUrl);
  const result = await page.evaluate(async (moduleUrl) => {
    const { mountDelayedPtyShell } = await import(moduleUrl);
    const shellRoot = document.createElement("div");
    shellRoot.style.width = "800px";
    shellRoot.style.height = "500px";
    const editor = document.createElement("textarea");
    editor.className = "kdemo-editor";
    document.body.append(shellRoot, editor);

    const fixture = mountDelayedPtyShell(shellRoot);
    const nextFrame = () => new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

    await fixture.waitForAttachRequest();
    await nextFrame();
    const terminalInput = shellRoot.querySelector(
      "textarea[aria-label='Terminal input']",
    );
    const initiallyFocusedTerminal =
      document.activeElement === terminalInput;

    editor.focus();
    fixture.resolveAttach();
    await Promise.resolve();
    await nextFrame();
    const editorKeptFocus = document.activeElement === editor;

    fixture.unmount();
    return { editorKeptFocus, initiallyFocusedTerminal };
  }, fixtureModuleUrl);

  expect(result).toEqual({
    editorKeptFocus: true,
    initiallyFocusedTerminal: true,
  });
});

test("terminal autofocus covers lifecycle boundaries", async ({ page }) => {
  await page.goto(helperModuleUrl);
  const result = await page.evaluate(async (moduleUrl) => {
    const { requestTerminalAutoFocus } = await import(moduleUrl);
    const editor = document.createElement("textarea");
    const terminal = document.createElement("div");
    const terminalInput = document.createElement("textarea");
    terminal.append(terminalInput);
    document.body.append(editor, terminal);

    let terminalFocusCalls = 0;
    const requestFocus = (
      autoFocus = true,
      isDisposed = () => false,
    ) => requestTerminalAutoFocus({
      autoFocus,
      container: terminal,
      focusTerminal: () => {
        terminalFocusCalls++;
        terminalInput.focus();
      },
      isDisposed,
    });
    const nextFrame = () => new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

    // Match the production race: xterm requests focus while its PTY attaches,
    // then the user starts filling the guide editor before that frame runs.
    requestFocus();
    editor.focus();
    await nextFrame();
    const editorKeptFocus = document.activeElement === editor;
    const callsWhileEditing = terminalFocusCalls;

    editor.blur();
    requestFocus(false);
    requestFocus(true, () => true);
    await nextFrame();
    const callsWhileDisabledOrDisposed = terminalFocusCalls;

    requestFocus();
    await nextFrame();
    const terminalReceivedOrdinaryFocus =
      document.activeElement === terminalInput;

    return {
      callsWhileDisabledOrDisposed,
      callsWhileEditing,
      editorKeptFocus,
      terminalFocusCalls,
      terminalReceivedOrdinaryFocus,
    };
  }, helperModuleUrl);

  expect(result).toEqual({
    callsWhileDisabledOrDisposed: 0,
    callsWhileEditing: 0,
    editorKeptFocus: true,
    terminalFocusCalls: 1,
    terminalReceivedOrdinaryFocus: true,
  });
});
