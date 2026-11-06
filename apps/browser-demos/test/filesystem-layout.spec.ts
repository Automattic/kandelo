import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { test } from "./support/persistent-page";
import { machineUrl, vfsImageUrlForProduct } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";

for (const product of ["browser-lamp", "browser-wordpress-family"]) {
  test(`FHS survives fresh browser composition of ${product}`, async ({ page, baseURL }) => {
    const imageUrl = await vfsImageUrlForProduct(page, product);
    await page.goto("/trap-signal-test.html");
    const result = await page.evaluate(async ({ imageUrl, workerUrl }) => {
      const worker = new Worker(workerUrl, { type: "module" });
      try {
        return await new Promise<{
          error?: string; profile: string; helper: { mode: number; uid: number; gid: number };
          helperSource: string; service: string; phpFpm: string;
          directories: Array<{ path: string; mode: number; uid: number; gid: number }>;
        }>((resolve, reject) => {
          worker.onmessage = event => resolve(event.data);
          worker.onerror = event => reject(new Error(event.message));
          worker.postMessage({ imageUrl });
        });
      } finally { worker.terminate(); }
    }, { imageUrl, workerUrl: new URL("/test/fixtures/composed-filesystem-layout-worker.ts", baseURL).href });
    expect(result.error).toBeUndefined();
    expect(result.helper).toMatchObject({ uid: 0, gid: 0 });
    expect(result.helper.mode & 0o7777).toBe(0o755);
    expect(result.helperSource).toContain("/run/mysqld/mysql.sock");
    expect(result.service).toContain("command = /bin/sh /usr/libexec/mariadb-ready");
    expect(result.phpFpm).toContain("depends-on = mariadb-ready");
    expect(result.directories.map(({ path }) => path)).toEqual([
      "/var/lib/mysql", "/var/lib/mysql/mysql", "/var/tmp/mysql",
      "/var/lib/mysql/test", "/var/log/mysql", "/run/mysqld",
    ]);
    for (const dir of result.directories) {
      expect(dir, dir.path).toMatchObject({ uid: 101, gid: 101 });
      expect(dir.mode & 0o177777, dir.path).toBe(0o040775);
    }
  });
}

test("the main shell uses FHS command paths and preserves the correct state across reboot", async ({ page }, testInfo) => {
  test.setTimeout(360_000);
  const expected = createHash("sha256").update(readFileSync(resolveBinary("programs/wasm32/shell.vfs.zst"))).digest("hex");
  const response = await page.request.get(await vfsImageUrlForProduct(page, "browser-main-shell"));
  expect(response.ok()).toBe(true);
  expect(createHash("sha256").update(await response.body()).digest("hex")).toBe(expected);

  await page.goto(await machineUrl(page, "shell"), { waitUntil: "domcontentloaded" });
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });
  await expect(page.locator(".xterm-rows").first()).toContainText(/kandelo(?:-bash-[0-9.]+)?\$ ?/, { timeout: 120_000 });
  await runTerminalCommand(page,
    "ok=1; for path in /bin/*; do name=${path##*/}; [[ ! -e /usr/bin/$name ]] || ok=0; done; " +
    "[[ $(type -P bash) == /bin/bash && $(type -P grep) == /bin/grep && " +
    "$(type -P make) == /usr/bin/make && $(type -P git) == /usr/bin/git && $ok == 1 ]] && " +
    "printf 'FHS_COMMAND_PATHS_OK\\n'", "FHS_COMMAND_PATHS_OK");

  const marker = `fhs-${Date.now()}`;
  await runTerminalCommand(page,
    `[[ $(readlink /var/run) == /run && -w /run/user/1000 ]] && ` +
    `printf 'retained\\n' > /var/tmp/${marker} && ` +
    `printf 'transient\\n' > /var/run/user/1000/${marker} && sync && ` +
    `printf 'FHS_STATE_SAVED\\n'`, "FHS_STATE_SAVED");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });
  await expect(page.locator(".xterm-rows").first()).toContainText(/kandelo(?:-bash-[0-9.]+)?\$ ?/, { timeout: 120_000 });
  await runTerminalCommand(page,
    `[[ $(cat /var/tmp/${marker}) == retained && ! -e /run/user/1000/${marker} && ` +
    `-w /run/user/1000 && $(readlink /var/run) == /run ]] && ` +
    `printf 'FHS_REBOOT_OK\\n'`, "FHS_REBOOT_OK");
  await runTerminalCommand(page,
    "command -v bash grep make git; ls -ld /bin /usr/bin /usr/local /var/tmp /run/user/1000; " +
    "printf 'FHS_LAYOUT_VERIFIED\\n'", "FHS_LAYOUT_VERIFIED");
  await page.screenshot({ path: resolve(import.meta.dirname, `../../../.context/fhs-layout-${testInfo.project.name}.png`) });
});
