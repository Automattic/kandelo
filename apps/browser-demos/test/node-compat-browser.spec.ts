import { expect, test } from "@playwright/test";
import { gotoMachineOrSkip } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";

// Exercise the packaged guest runtime on each browser host, through the
// ordinary lazy node archive and filesystem, rather than host JavaScript.
const probe = `
import vm from 'node:vm';
import { randomBytes } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { execFile } from 'node:child_process';
function check(ok, message) { if (!ok) throw new Error(message); }
globalThis.outer = 99;
const context = vm.createContext({ seed: 41 });
check(vm.runInContext('seed + 1', context) === 42, 'vm computation');
check(vm.runInContext('typeof outer', context) === 'undefined', 'vm isolation');
check(!randomBytes(32).equals(randomBytes(32)), 'randomness');
const frame = Buffer.from('28b52ffd0458b9000068656c6c6f207a7374642066726f6d206b616e64656c6f4e81847f', 'hex');
check(zstdDecompressSync(frame).toString() === 'hello zstd from kandelo', 'zstd decode');
let rejected = false;
try { zstdDecompressSync(frame.subarray(0, frame.length - 6)); }
catch { rejected = true; }
check(rejected, 'truncated zstd must fail');
const output = await new Promise((resolve, reject) => {
  execFile('/bin/echo', ['guest-child'], (error, stdout) => {
    if (error) reject(error); else resolve(stdout.trim());
  });
});
check(output === 'guest-child', 'async child process');
console.log('COMPAT_' + 'BROWSER', 'esm', 'vm', 'random', 'zstd', 'child');
`;

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

test("packaged Node compatibility supports ESM, isolated vm, zstd and async children", async ({ page }) => {
  test.setTimeout(420_000);
  await gotoMachineOrSkip(page, "node");
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 180_000 });
  await expect.poll(
    () => page.locator(".xterm-rows").first().textContent(),
    { timeout: 180_000 },
  ).toContain("kandelo$");
  const result = await runTerminalCommand(
    page,
    `printf '%s' ${shellQuote(probe)} > /tmp/node-compat-probe.mjs && node /tmp/node-compat-probe.mjs`,
    "COMPAT_BROWSER esm vm random zstd child",
    180_000,
  );
  expect(result.exitCode).toBe(0);
});
