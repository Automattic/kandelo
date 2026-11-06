import { expect, test } from "@playwright/test";
import { TMUX_CONTROL_MARKERS, TMUX_CONTROL_SCRIPT } from "../../../packages/registry/tmux/test/contracts";
import { tmuxRelPath, tmuxTerminfoFiles } from "../../../packages/registry/tmux/test/artifacts";
import { devServerAssetUrl } from "./support/dev-server-assets";

test("tmux pane shells, input, splits, windows and resizing", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/pages/test-runner/?minimal=1");
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);
  const bashUrl = await devServerAssetUrl(page, "@binaries/programs/wasm32/bash.wasm");
  const tmuxUrl = await devServerAssetUrl(page, `@binaries/${tmuxRelPath}`);
  const result = await page.evaluate(async ({ bashUrl, tmuxUrl, script, terminfoFiles }) => {
    const load = async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`program fetch failed: ${response.status} ${url}`);
      return response.arrayBuffer();
    };
    const bash = await load(bashUrl);
    const tmux = await load(tmuxUrl);
    return (window as any).__runTest(bash,
      ["bash", "--noprofile", "--norc", "-c", script], 90_000, {
        env: ["HOME=/tmp", "PATH=/usr/bin:/bin", "LC_ALL=C.UTF-8"],
        dataFiles: [
          { path: "/bin/sh", useWasmBytes: true },
          { path: "/bin/bash", useWasmBytes: true },
          { path: "/usr/bin/tmux", data: Array.from(new Uint8Array(tmux)) },
          ...terminfoFiles,
        ],
      });
  }, { bashUrl, tmuxUrl, script: TMUX_CONTROL_SCRIPT, terminfoFiles: tmuxTerminfoFiles() });
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  for (const marker of TMUX_CONTROL_MARKERS) expect(result.stdout).toContain(marker);
  expect(result.stderr).toBe("");
  expect(result.hostDiagnostics).toEqual([]);
  expect(errors).toEqual([]);
});
