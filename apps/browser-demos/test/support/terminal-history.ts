import { expect, type Locator } from "@playwright/test";

/** Read the actual rendered scrollback through xterm's ordinary keyboard UI. */
export async function terminalHistoryMatching(
  terminal: Locator,
  pattern: RegExp,
): Promise<string> {
  const screen = terminal.locator(".xterm-screen");
  const input = terminal.locator(".xterm-helper-textarea");
  const rows = terminal.locator(".xterm-rows > div");
  const slider = terminal.locator(".scrollbar.vertical > .slider");
  const position = async () => {
    const track = await terminal.locator(".scrollbar.vertical").boundingBox();
    const thumb = await slider.boundingBox();
    if (!track || !thumb) throw new Error("terminal scrollbar is not rendered");
    return {
      top: thumb.y - track.y,
      bottom: track.y + track.height - thumb.y - thumb.height,
    };
  };
  const page = async (direction: "Up" | "Down") => {
    await input.press(`Shift+Page${direction}`);
    // WHY: xterm renders virtual rows asynchronously. A screenshot observes
    // their paint instead of reading the rows left from the previous page.
    await screen.screenshot();
  };
  const bottom = async () => {
    await expect(async () => {
      if ((await position()).bottom > 1) await page("Down");
      expect((await position()).bottom).toBeLessThanOrEqual(1);
    }).toPass({ timeout: 10_000, intervals: [0] });
  };

  // WHY: xterm 6 uses its own scrollbar. The retained .xterm-viewport DOM
  // element has no scroll range; assigning its scrollTop silently does nothing.
  await input.focus();
  await screen.screenshot();
  await bottom();
  let text = "";
  try {
    await expect(async () => {
      text = `${(await rows.allInnerTexts()).join("\n")}\n${text}`;
      if (pattern.test(text) || (await position()).top <= 1) return;
      await page("Up");
      throw new Error("terminal history scan has more rendered pages");
    }).toPass({ timeout: 10_000, intervals: [0] });
    return text;
  } finally {
    await bottom();
  }
}
