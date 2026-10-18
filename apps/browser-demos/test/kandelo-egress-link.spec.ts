import { expect, test } from "@playwright/test";
import { gotoMachine } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";

// The browser's internet egress is a NAT link of its own
// (host/src/networking/egress-link.ts): the guest is 10.0.2.15, names
// resolve to made-up 198.18.0.0/15 addresses, and UDP beyond the machine
// fails with EHOSTUNREACH. Inside the guest 127.0.0.1 is the guest itself,
// so the dev server is reached by a name that resolves to it.

test("internet streams leave from the guest's own NAT address", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  await gotoMachine(page, "shell");
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });
  const port = new URL(baseURL!).port;
  const curl = await runTerminalCommand(page,
    `curl -s -o /dev/null -w 'egress %{remote_ip} %{local_ip}\\n' http://127.0.0.1.nip.io:${port}/`);
  // Any HTTP answer proves the stream; the dev server's status is not the point.
  expect(curl.output).toMatch(/egress 198\.1[89]\.\d+\.\d+ 10\.0\.2\.15\b/);
});

test("a UDP datagram for beyond the machine fails with EHOSTUNREACH", async ({ page }) => {
  test.setTimeout(240_000);
  await gotoMachine(page, "shell");
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });
  // fbdoom's LAN search broadcasts; outside a session only the gateway is on
  // the link, and it cannot carry UDP. fbdoom waits after a fatal error
  // rather than exiting, so the search runs under timeout.
  const search = await runTerminalCommand(page, "timeout 20 fbdoom -localsearch 2>&1; true");
  expect(search.output).toContain("UDP send failed: Host is unreachable");
});
