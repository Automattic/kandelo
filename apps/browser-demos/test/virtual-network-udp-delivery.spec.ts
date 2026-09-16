// `network.spec.ts` covers the whole lab and is `test.fixme()`'d for a known
// multi-kernel scheduling gap: "UDP delivery succeeds, but netcat workers do
// not complete after I/O". Because the fixme disables the entire spec, the
// browser has had *no* live coverage of the virtual network at all -- not even
// of the half that works.
//
// This covers that half. It asserts only what the fixme says already
// succeeds -- three machines attach, alpha binds a UDP port, and beta's
// datagram is routed to it through real GNU netcat over SOCK_DGRAM -- and
// deliberately does not assert the scenario row flipping to "passed", which
// is the part still blocked.
//
// It is the browser-side evidence for the bind-conflict authority moving to
// `crates/runtime-core/src/socket.rs` (K11): if the fabric stopped
// registering binds, or routed to the wrong endpoint, alpha would never see
// the datagram.
import { expect, test } from "@playwright/test";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

test("virtual network still attaches machines and routes a UDP datagram", async ({ page }) => {
  test.setTimeout(180_000);

  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

  await page.goto(appUrl("/pages/network/"), { waitUntil: "domcontentloaded" });
  await page.locator("#run").click();

  // The scenario row never flips to "passed" because netcat does not exit
  // (that is the fixme). Delivery is what this asserts: beta's datagram
  // arriving on alpha's stdout means alpha's UDP bind was registered with the
  // fabric and the datagram was routed to it.
  await expect(page.locator("body")).toContainText(
    "[alpha:stdout] hello from beta over udp",
    { timeout: 150_000 },
  );

  const log = await page.locator("body").innerText();
  console.log("K11_BIND_ERRORS=" + JSON.stringify(
    errors.filter((e) => /EADDRINUSE|errno 98|registration failed/i.test(e)),
  ));
  console.log("K11_LOG_HAS_BIND_FAILURE=" + /registration failed|EADDRINUSE/i.test(log));
});
