import { expect, test } from "@playwright/test";
import { gotoMachineOrSkip } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";

test("shell optional speech, file-type and desktop data download only on first use", async ({ page }) => {
  test.setTimeout(240_000);
  const requests = new Map<string, string[]>();
  const assets = ["espeak-ng-data", "file-magic", "kandelo-desktop-data"];
  page.on("request", request => {
    if (!["fetch", "xhr"].includes(request.resourceType())) return;
    const url = new URL(request.url());
    if (url.searchParams.has("import") || url.searchParams.has("url")) return;
    for (const asset of assets) {
      if (new RegExp(`/${asset}(?:-[^/]+)?\\.(?:zip|lite)$`).test(url.pathname)) {
        const prior = requests.get(asset) ?? [];
        prior.push(request.url());
        requests.set(asset, prior);
      }
    }
  });
  await gotoMachineOrSkip(page, "shell");
  await expect.poll(() => page.locator(".xterm-rows").first().textContent(), {
    timeout: 120_000,
  }).toContain("kandelo$");
  expect([...requests.entries()]).toEqual([]);
  const command = [
    "set -eu",
    "espeak-ng --stdout hello > /tmp/lazy-speech.wav",
    'IFS= read -r -N 4 signature < /tmp/lazy-speech.wav',
    'test "$signature" = RIFF',
    "printf 'speech-data-ok\\n'",
    "file -b /etc/passwd",
    "while IFS= read -r line; do printf '%s\\n' \"$line\"; done < /usr/share/kandelo/themes/tokyo-night/theme.conf",
  ].join("; ");
  for (let iteration = 0; iteration < 2; iteration++) {
    const result = await runTerminalCommand(page, command, "Tokyo Night", 120_000);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("speech-data-ok");
    expect(result.output).toContain("ASCII text");
    for (const asset of assets) expect(requests.get(asset), asset).toHaveLength(1);
  }
});
