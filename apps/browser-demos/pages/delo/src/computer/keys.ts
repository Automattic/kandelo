// Keys an agent presses on a delo computer's screen: browser key events
// dispatched on the screen's canvas, so they take the same path as the
// user's own keys. Each key is a DOM `code` such as "KeyA" or "ArrowUp".

export async function pressKeys(target: HTMLElement, codes: readonly string[], holdMs: number): Promise<void> {
  const send = (type: "keydown" | "keyup", code: string) => target.dispatchEvent(new KeyboardEvent(type, { code, key: "Unidentified", bubbles: true, cancelable: true }));
  for (const code of codes) send("keydown", code);
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  for (const code of [...codes].reverse()) send("keyup", code);
}
