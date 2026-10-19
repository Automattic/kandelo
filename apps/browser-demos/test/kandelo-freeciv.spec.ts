import { expect, test, type Page } from "@playwright/test";
import { gotoMachine } from "./support/kandelo-machine";
import { writeFileSync } from "node:fs";
import { buildTerminalCommand, parseTerminalCommandResult } from "./support/terminal-command";

const running = (page: Page) => expect(page.locator(".kdock-status-text"))
  .toHaveAttribute("data-status", "running", { timeout: 180_000 });
const canvas = (page: Page) => page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();
test.beforeEach(async ({ page }) => {
  const observe = (target: Page) => {
    target.on("pageerror", error => console.log(`browser error: ${error.message}`));
    target.on("console", message => {
      if (["error", "warning"].includes(message.type())) console.log(`browser ${message.type()}: ${message.text()}`);
    });
    target.on("requestfailed", request => console.log(`request failed: ${request.url()} ${request.failure()?.errorText}`));
    target.on("response", response => {
      if (response.url().endsWith("/freeciv.zip")) console.log(`Freeciv archive: ${response.url()}`);
    });
  };
  observe(page);
  page.context().on("page", observe);
});
async function showGame(page: Page, { pointerLock = false } = {}) {
  // Absolute-input regressions explicitly release browser capture. Dedicated
  // capture cases retain it and drive native relative movement instead.
  // Do not replace requestPointerLock or pretend a request succeeded.
  await page.evaluate(keep => {
    const scope = globalThis as any;
    scope.__retainPointerLock = keep;
    if (!scope.__releaseTestPointerLock) {
      scope.__releaseTestPointerLock = () => {
        if (!scope.__retainPointerLock && document.pointerLockElement) document.exitPointerLock();
      };
      document.addEventListener("pointerlockchange", scope.__releaseTestPointerLock);
    }
    scope.__releaseTestPointerLock();
  }, pointerLock);
  await page.getByRole("button", { name: "Demo", exact: true }).click({ timeout: 60_000 });
  await expect(canvas(page)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Waiting for PAGE_FLIP on CRTC/)).toBeHidden({ timeout: 120_000 });
  await expect.poll(async () => (await canvas(page).screenshot()).byteLength,
    { timeout: 60_000 }).toBeGreaterThan(5_000);
}
async function terminalLines(page: Page) {
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  const output = await page.locator(".xterm-rows").first().evaluate(
    node => [...node.children].map(row => row.textContent).join("\n"));
  const demo = page.getByRole("button", { name: "Demo", exact: true });
  if (await demo.isEnabled()) await demo.click();
  return output;
}
async function guestCommand(page: Page, command: string) {
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  const slot = page.locator(".kshell-terminal-slot:not([hidden])");
  const transcript = () => slot.locator(".xterm-rows").innerText();
  await expect.poll(transcript, { timeout: 60_000 }).toMatch(/kandelo\$\s*$/);
  const protocol = buildTerminalCommand(command);
  await slot.locator(".xterm-screen").click();
  await page.keyboard.insertText(protocol.command);
  await page.keyboard.press("Enter");
  await expect.poll(async () => parseTerminalCommandResult(await transcript(), protocol), { timeout: 60_000 })
    .toBeDefined();
  const result = parseTerminalCommandResult(await transcript(), protocol)!;
  expect(result.exitCode, result.output).toBe(0);
  return result.output;
}

async function nativeAction(page: Page, action: () => Promise<unknown>) {
  const box = (await canvas(page).boundingBox())!;
  const screenshot = () => page.screenshot({ clip: box, scale: "css" });
  const before = await screenshot();
  await action();
  // Cursor planes present independently; motion must not require a scene flip.
  await expect.poll(async () => Buffer.compare(before, await screenshot()),
    { timeout: 30_000 }).not.toBe(0);
}

// Native coordinates follow the actual scanout, including the minimum mode
// on small panes. CSS size and browser device density are separate concerns.
async function nativePosition(page: Page, x: number, y: number) {
  const box = (await canvas(page).boundingBox())!;
  const status = await page.getByText(/\d+×\d+ · \d+ flips/).innerText();
  const [, w, h] = status.match(/(\d+)×(\d+)/)!;
  const width = Number(w), height = Number(h);
  return { x: box.width * (x < 0 ? width + x : x) / width,
    y: box.height * (y < 0 ? height + y : y) / height };
}
async function menuPosition(page: Page, entry: "new" | "options" | "quit") {
  return nativePosition(page, -100, -({ new: 170, options: 55, quit: 32 }[entry]));
}

// Observe a painted native panel rather than racing the guest's next frame.
async function waitForPanel(page: Page, x: number, y: number, visible = true) {
  const box = await canvas(page).boundingBox();
  expect(box).not.toBeNull();
  await expect.poll(async () => {
    const png = await page.screenshot({ clip: { x: box!.x + x, y: box!.y + y, width: 1, height: 1 } });
    return page.evaluate(async encoded => {
      const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const sample = new OffscreenCanvas(1, 1).getContext("2d")!;
      sample.drawImage(bitmap, 0, 0, 1, 1);
      const [r, g, b] = sample.getImageData(0, 0, 1, 1).data;
      bitmap.close();
      return r > 160 && g > 140 && b > 110;
    }, png.toString("base64"));
  }, { timeout: 30_000 }).toBe(visible);
}

// The empty center of the Options titlebar is a long light horizontal run.
// A single warm map pixel is insufficient: terrain can have the same color.
async function waitForOptions(page: Page, visible = true) {
  await waitForTitlebar(page, -50, -220, visible);
}
async function waitForNationPicker(page: Page, visible = true) {
  const box = (await canvas(page).boundingBox())!;
  await expect.poll(async () => {
    const png = await page.screenshot({ scale: "css", clip: {
      x: box.x + box.width / 2 + 100, y: box.y + box.height / 2 - 360,
      width: 150, height: 6,
    } });
    return page.evaluate(async encoded => {
      const bitmap = await createImageBitmap(new Blob([
        Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
      ], { type: "image/png" }));
      const ctx = new OffscreenCanvas(150, 6).getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0); bitmap.close();
      const pixels = ctx.getImageData(0, 0, 150, 6).data;
      for (let y = 0; y < 6; y++) {
        let dark = 0;
        for (let x = 0; x < 150; x++) {
          const i = (y * 150 + x) * 4;
          if (pixels[i] < 160 && pixels[i + 1] < 160 && pixels[i + 2] < 160) dark++;
        }
        if (dark > 142) return true;
      }
      return false;
    }, png.toString("base64"));
  }, { timeout: 15_000 }).toBe(visible);
}
async function waitForTitlebar(page: Page, xOffset: number, yOffset: number, visible = true) {
  const box = (await canvas(page).boundingBox())!;
  await expect.poll(async () => {
    const png = await page.screenshot({ scale: "css", clip: {
      x: box.x + box.width / 2 + xOffset, y: box.y + box.height / 2 + yOffset,
      width: 150, height: 1,
    } });
    return page.evaluate(async encoded => {
      const bitmap = await createImageBitmap(new Blob([
        Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
      ], { type: "image/png" }));
      const sample = new OffscreenCanvas(150, 1).getContext("2d")!;
      sample.drawImage(bitmap, 0, 0, 150, 1);
      const pixels = sample.getImageData(0, 0, 150, 1).data;
      bitmap.close();
      let light = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 220 && pixels[i + 1] > 210 && pixels[i + 2] > 180) light++;
      }
      return light > 142;
    }, png.toString("base64"));
  }, { timeout: 10_000 }).toBe(visible);
}

// Wait for the native editor to own text input before typing a command.
async function waitForChatInput(page: Page) {
  const box = (await canvas(page).boundingBox())!;
  await expect.poll(async () => {
    const png = await page.screenshot({ scale: "css", clip: {
      x: box.x + box.width / 2 - 175, y: box.y + box.height / 2 + 2,
      width: 350, height: 1,
    } });
    return page.evaluate(async encoded => {
      const bitmap = await createImageBitmap(new Blob([
        Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
      ], { type: "image/png" }));
      const sample = new OffscreenCanvas(350, 1).getContext("2d")!;
      sample.drawImage(bitmap, 0, 0, 350, 1);
      const pixels = sample.getImageData(0, 0, 350, 1).data;
      bitmap.close();
      let light = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 220 && pixels[i + 1] > 210 && pixels[i + 2] > 180) light++;
      }
      return light > 340;
    }, png.toString("base64"));
  }, { timeout: 10_000 }).toBe(true);
}

async function multiplayer(page: Page, entry: "host" | "join" | "local") {
  await page.getByTestId("kms-dock-action-multiplayer").click({ timeout: 15_000 });
  await page.getByTestId(`kms-dock-menu-entry-${entry}`).click({ timeout: 15_000 });
}

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  await page.evaluate(() => document.exitPointerLock());
  await page.screenshot({ path: "../../.context/freeciv-browser-failure.png" });
  writeFileSync("../../.context/freeciv-browser-failure.txt", await page.locator("body").innerText());
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  writeFileSync("../../.context/freeciv-browser-terminal.txt", await page.locator("body").innerText());
});

test("Freeciv's SDL2 client renders its main menu", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "initial graphical acceptance targets Chromium");
  test.setTimeout(240_000);
  console.log("Resolving and booting the Freeciv machine");
  await gotoMachine(page, "freeciv");
  console.log(`Boot URL: ${page.url()}`);
  writeFileSync("../../.context/freeciv-current-demo-url.txt", page.url());
  await expect(page.locator(".kdock-status-text"))
    .toHaveAttribute("data-status", "running", { timeout: 180_000 });
  await showGame(page);
  const display = await canvas(page).boundingBox();
  expect(display).not.toBeNull();
  await waitForPanel(page, display!.width - 60, display!.height - 60);
  await page.screenshot({ path: "../../.context/freeciv-main-menu.png" });
});

test("overlapping mouse buttons produce distinct kernel input records", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "trusted mouse chord regression targets Chromium");
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    (globalThis as any).__mouseButtonTrace = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: any, ...rest: any[]) {
      const records = message?.type === "input_event_batch_inject" ? message.records
        : message?.type === "input_event_inject" ? [message] : [];
      for (const event of records) {
        if (event.device === 1 && event.ev_type === 1) {
          (globalThis as any).__mouseButtonTrace.push([event.code, event.value]);
        }
      }
      return Reflect.apply(post, this, [message, ...rest]);
    };
  });
  await gotoMachine(page, "freeciv");
  await running(page);
  await showGame(page);
  const box = (await canvas(page).boundingBox())!;
  await waitForPanel(page, box.width - 60, box.height - 60);
  await page.mouse.move(box.x + 300, box.y + 180);
  await page.evaluate(() => { (globalThis as any).__mouseButtonTrace = []; });
  // Pointer Events use pointermove for the second press and first release.
  // Observe the real worker messages without replacing their dispatch.
  await page.mouse.down({ button: "left" });
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "left" });
  await page.mouse.up({ button: "right" });
  await page.mouse.move(box.x + 310, box.y + 180);
  const events = await page.evaluate(() => (globalThis as any).__mouseButtonTrace);
  writeFileSync("../../.context/freeciv-mouse-chord-events.json", JSON.stringify(events));
  expect(events).toEqual([[272, 1], [273, 1], [272, 0], [273, 0]]);
  // Simulate an OS/browser transition that loses both release notifications.
  // The next trusted movement reports buttons=0 and must end the old press.
  await page.evaluate(() => {
    (globalThis as any).__mouseButtonTrace = [];
    const block = (e: Event) => e.stopImmediatePropagation();
    window.addEventListener("pointerup", block, true);
    window.addEventListener("lostpointercapture", block, true);
    (globalThis as any).__unblockPointerRelease = () => {
      window.removeEventListener("pointerup", block, true);
      window.removeEventListener("lostpointercapture", block, true);
    };
  });
  try {
    await page.mouse.down({ button: "left" });
    await page.mouse.up({ button: "left" });
    await page.mouse.move(box.x + 330, box.y + 180);
  } finally {
    await page.evaluate(() => (globalThis as any).__unblockPointerRelease());
  }
  expect(await page.evaluate(() => (globalThis as any).__mouseButtonTrace))
    .toEqual([[272, 1], [272, 0]]);
  const input = await page.context().newCDPSession(page);
  await input.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
  await page.evaluate(() => { (globalThis as any).__mouseButtonTrace = []; });
  try {
    await input.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
      { id: 1, x: box.x + 300, y: box.y + 180 },
    ] });
    await expect.poll(() => page.evaluate(() => (globalThis as any).__mouseButtonTrace))
      .toEqual([[272, 1]]);
    // A hovering mouse is a different pointer; its buttons=0 must not
    // release the finger that owns the guest's current drag.
    await page.mouse.move(box.x + 350, box.y + 180);
    expect(await page.evaluate(() => (globalThis as any).__mouseButtonTrace))
      .toEqual([[272, 1]]);
  } finally {
    await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await input.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await input.detach();
  }
  expect(await page.evaluate(() => (globalThis as any).__mouseButtonTrace))
    .toEqual([[272, 1], [272, 0]]);
  // Require real native buttons to accept subsequent clicks, twice.
  for (let i = 0; i < 2; i++) {
    await canvas(page).click({ position: await menuPosition(page, "options") });
    await waitForPanel(page, box.width / 2 + 100, box.height / 2 + 100);
    if (i === 1) await page.screenshot({ path: "../../.context/freeciv-pointer-recovery.png", scale: "css" });
    await page.keyboard.press("Escape");
    await waitForPanel(page, box.width / 2 + 100, box.height / 2 + 100, false);
  }
});

// Keep real ICE evidence when a local peer connection fails; successful
// application startup cannot explain a transport failure before TCP joins.
async function recordPeerRoute(page: Page) {
  await page.addInitScript(() => {
    const Native = RTCPeerConnection;
    const traces: any[] = [];
    const byConnection = new WeakMap<RTCPeerConnection, any>();
    (globalThis as any).__freecivPeerRoutes = traces;
    const connections: RTCPeerConnection[] = [];
    (globalThis as any).__freecivPeerConnections = connections;
    globalThis.RTCPeerConnection = class extends Native {
      constructor(...args: ConstructorParameters<typeof Native>) {
        super(...args);
        connections.push(this);
        const trace = { candidates: [] as string[], candidateTimes: [] as any[], errors: [] as any[],
          descriptionReads: [] as any[], states: [] as any[], stats: [] as any[] };
        traces.push(trace);
        byConnection.set(this, trace);
        let sampling = false;
        const sampleStats = () => {
          if (sampling || this.connectionState === "closed") return;
          sampling = true;
          const at = performance.now();
          void this.getStats().then(report => {
            trace.stats.push({ at, records: [...report.values()].filter(record =>
              ["candidate-pair", "local-candidate", "remote-candidate", "transport"].includes(record.type)) });
          }, error => trace.stats.push({ at, error: String(error) })).finally(() => {
            sampling = false;
            if (trace.stats.length > 128) trace.stats.shift();
          });
        };
        // Failure handlers close RTC immediately; a later getStats() can be
        // empty. Retain bounded samples from the live connection instead.
        const sampler = window.setInterval(() => {
          if (["connected", "failed", "closed"].includes(this.connectionState)) window.clearInterval(sampler);
          else sampleStats();
        }, 500);
        this.addEventListener("icecandidate", event => {
          if (event.candidate) {
            trace.candidates.push(event.candidate.candidate);
            trace.candidateTimes.push({ at: performance.now(), type: event.candidate.type });
          }
        });
        this.addEventListener("icecandidateerror", event => trace.errors.push({
          at: performance.now(), url: event.url, code: event.errorCode, message: event.errorText,
        }));
        for (const event of ["connectionstatechange", "iceconnectionstatechange", "icegatheringstatechange"]) {
          this.addEventListener(event, () => {
            trace.states.push({
              at: performance.now(), connection: this.connectionState,
              ice: this.iceConnectionState, gathering: this.iceGatheringState,
              remote: this.remoteDescription?.sdp.split("\r\n")
                .filter(line => line.startsWith("a=candidate:")),
            });
            sampleStats();
          });
        }
      }
      get localDescription() {
        const description = super.localDescription;
        const trace = byConnection.get(this);
        // The single-code publisher reads this getter after its gather wait.
        // Record that exact candidate set, independently of later events.
        trace?.descriptionReads.push({ at: performance.now(), gathering: this.iceGatheringState,
          candidates: description?.sdp.split("\r\n").filter(line => line.startsWith("a=candidate:")),
        });
        return description;
      }
    } as typeof Native;
  });
}

test.describe("local Freeciv peer routing", () => {
  // Chromium's own IP-permission tests require a media grant to enumerate
  // non-default interfaces, including loopback. This isolated test context
  // grants permission without opening a microphone. Production asks for none.
  // https://github.com/chromium/chromium/blob/main/content/browser/webrtc/webrtc_ip_permissions_browsertest.cc
  test.use({ permissions: ["microphone"] });

  test("two Freeciv clients start a game over a network session", async ({ browser, page, browserName }) => {
    test.skip(browserName !== "chromium", "the local peer fixture uses Chromium's ICE candidate flags");
    test.setTimeout(480_000);
    page.setDefaultTimeout(15_000);
    await recordPeerRoute(page);
    console.log("Booting the multiplayer host");
    await gotoMachine(page, "freeciv");
    await running(page);
    await showGame(page);
    console.log("Creating the network session");
    await page.getByRole("button", { name: "Network session: not connected", exact: true }).click();
    await page.getByLabel("Session name").fill("Freeciv night");
    await page.getByRole("button", { name: "Create session", exact: true }).click();
    await expect(page.getByRole("button", { name: "Network session: connected", exact: true }))
      .toBeAttached({ timeout: 30_000 });
    const link = await page.locator("[data-network-link]").getAttribute("data-network-link");
    expect(link).toBeTruthy();
    await page.locator(".knetwork .kshare-x").click();
    console.log("Starting the hosting Freeciv server and client");
    await multiplayer(page, "host");
    await expect.poll(() => terminalLines(page), { timeout: 90_000 })
      .toMatch(/Player-[0-9a-f]+ has connected from (?:localhost|127\.0\.0\.1)/);
    console.log("Host client connected; opening the invited machine");
    const context = await browser.newContext({ permissions: ["microphone"] });
    const joiner = await context.newPage();
    joiner.setDefaultTimeout(15_000);
    await recordPeerRoute(joiner);
    try {
      await joiner.goto(link!, { waitUntil: "domcontentloaded" });
      await running(joiner);
      await joiner.getByRole("button", { name: "Join session", exact: true }).click();
      await expect(joiner.locator(".knetwork-status")).toContainText("this computer is 10.89.0.2", { timeout: 90_000 });
      // Prove that this is the intended local fixture rather than a lucky LAN
      // hairpin route. Observe the browser's selected pair without rewriting SDP.
      for (const player of [page, joiner]) {
        await expect.poll(() => player.evaluate(async () => {
          for (const rtc of (globalThis as any).__freecivPeerConnections as RTCPeerConnection[]) {
            const report = await rtc.getStats();
            for (const transport of report.values()) {
              if (transport.type !== "transport" || !transport.selectedCandidatePairId) continue;
              const pair = report.get(transport.selectedCandidatePairId);
              const addresses = [pair?.localCandidateId, pair?.remoteCandidateId]
                .map(id => id && report.get(id)?.address);
              if (addresses.some(address => address === "127.0.0.1" || address === "::1")) return true;
            }
          }
          return false;
        }), { timeout: 15_000 }).toBe(true);
      }
      await joiner.locator(".knetwork .kshare-x").click();
      await showGame(joiner);
      console.log("Joining Freeciv through the peer network");
      await multiplayer(joiner, "join");
      await expect.poll(() => terminalLines(page), { timeout: 90_000 })
        .toMatch(/Player-[0-9a-f]+ has connected from 10\.89\.0\.2/);
      await showGame(page);
      await showGame(joiner);
      for (const player of [page, joiner]) {
        await expect(player.getByTestId("kms-dock-action-status")).toHaveCount(0, { timeout: 30_000 });
      }
      await page.screenshot({ path: "../../.context/freeciv-network-host.png" });
      await joiner.screenshot({ path: "../../.context/freeciv-network-joiner.png" });
      console.log("Both lobbies rendered; starting the game from each client");
      // Both players press Freeciv's own Start button in the connection lobby.
      for (const player of [page, joiner]) {
        const display = canvas(player);
        const box = await display.boundingBox();
        expect(box).not.toBeNull();
        await display.click({ position: { x: box!.width * 0.925, y: box!.height * 0.95 } });
      }
      await expect.poll(() => terminalLines(page), { timeout: 90_000 }).toMatch(/rules the/);
      await showGame(page);
      await showGame(joiner);
      // End a turn from both keyboards and observe the year/status strip
      // change on each real game display after the server advances the turn.
      const headers = [];
      for (const player of [page, joiner]) {
        const display = await canvas(player).boundingBox();
        expect(display).not.toBeNull();
        const clip = { x: display!.x + 300, y: display!.y + 3, width: 480, height: 12 };
        headers.push({ player, clip, before: await player.screenshot({ clip }) });
      }
      for (const player of [page, joiner]) {
        await canvas(player).focus();
        await player.keyboard.press("Shift+Enter", { delay: 100 });
      }
      for (const { player, clip, before } of headers) {
        await expect.poll(async () => Buffer.compare(before, await player.screenshot({ clip })),
          { timeout: 60_000 }).not.toBe(0);
      }
      await page.screenshot({ path: "../../.context/freeciv-game-host.png" });
      await joiner.screenshot({ path: "../../.context/freeciv-game-joiner.png" });
      for (const player of [page, joiner]) {
        await expect(player.getByTestId("kms-dock-action-error")).toHaveCount(0);
      }
    } finally {
      for (const [name, player] of [["host", page], ["joiner", joiner]] as const) {
        // Each repeat owns its evidence: a later successful session must never
        // overwrite the candidate pairs from the intermittent failure.
        const evidencePath = test.info().outputPath(`peer-${name}-routes.json`);
        writeFileSync(evidencePath, JSON.stringify(
          await player.evaluate(() => (globalThis as any).__freecivPeerRoutes)
            .catch(error => ({ error: String(error) })), null, 2));
        await test.info().attach(`peer-${name}-routes`, { path: evidencePath, contentType: "application/json" });
      }
      await context.close();
    }
  });

});

test("New Game launches Freeciv's own local server child", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "graphical acceptance targets Chromium");
  test.setTimeout(240_000);
  page.setDefaultTimeout(15_000);
  await gotoMachine(page, "freeciv");
  await running(page);
  await showGame(page);
  const box = await canvas(page).boundingBox();
  expect(box).not.toBeNull();
  // Start New Game in the upstream menu, anchored above the bottom edge.
  await waitForPanel(page, box!.width - 60, box!.height - 60);
  await nativeAction(page, async () => canvas(page).click({ position: await menuPosition(page, "new") }));

  // Observe the real child through /proc from a separate guest login shell.
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  const slot = page.locator(".kshell-terminal-slot:not([hidden])");
  const transcript = () => slot.locator(".xterm-rows").innerText();
  await expect.poll(transcript, { timeout: 60_000 }).toMatch(/kandelo\$\s*$/);
  const protocol = buildTerminalCommand([
    "for path in /proc/[0-9]*/cmdline; do",
    "  command=$(tr '\\0' ' ' < \"$path\" 2>/dev/null)",
    "  case \"$command\" in",
    "    /usr/libexec/freeciv/server.wasm\\ *|freeciv-server\\ *) printf 'FREECIV_LOCAL_SERVER=%s\\n' \"$command\" ;;",
    "  esac",
    "done",
  ].join("\n"));
  await slot.locator(".xterm-screen").click();
  await page.keyboard.insertText(protocol.command);
  await page.keyboard.press("Enter");
  await expect.poll(async () => parseTerminalCommandResult(await transcript(), protocol), { timeout: 60_000 })
    .toMatchObject({ exitCode: 0, output: expect.stringMatching(/FREECIV_LOCAL_SERVER=.*-p 5557 .*--bind localhost/) });
  await showGame(page);
  // The lobby paints chat text in the otherwise empty top-left of the
  // intro screen. Wait for that real frame, not only for the child spawn.
  const display = await canvas(page).boundingBox();
  expect(display).not.toBeNull();
  await expect.poll(async () => (await page.screenshot({ clip: {
    x: display!.x, y: display!.y, width: 250, height: 60,
  } })).byteLength, { timeout: 60_000 }).toBeGreaterThan(1_000);
  await page.screenshot({ path: "../../.context/freeciv-local-lobby.png" });
});

// These are native display pixels inside the guest, with the same CSS pane.
// Exercise the upstream settings UI at both ordinary and Retina density.
for (const density of [1, 2]) {
  test.describe(`Freeciv at ${density}x display density`, () => {
    test.use({
      // Native compositor density is needed too: Chromium's emulated DPR
      // alone leaves ResizeObserver's device-pixel box at the host density.
      page: async ({ playwright, launchOptions, headless, browserName, baseURL }, use) => {
        const browser = await playwright[browserName].launch({
          ...launchOptions,
          headless,
          args: browserName === "chromium"
            ? [...(launchOptions.args ?? []), `--force-device-scale-factor=${density}`]
            : launchOptions.args,
        });
        try {
          const context = await browser.newContext({
            baseURL, deviceScaleFactor: density, viewport: { width: 1440, height: 1000 },
          });
          await use(await context.newPage());
        } finally {
          await browser.close();
        }
      },
    });
    test("pointer capture beyond display edges preserves cursor and menu clicks", async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "direct-display input regression targets Chromium");
      test.setTimeout(150_000);
      await gotoMachine(page, "freeciv");
      await running(page);
      await showGame(page);
      const box = (await canvas(page).boundingBox())!;
      await waitForPanel(page, box.width - 60, box.height - 60);
      const worker = page.workers().find(worker => /browser-kernel-worker-entry/.test(worker.url()));
      expect(worker).toBeTruthy();
      await worker!.evaluate(() => {
        const proto = OffscreenCanvasRenderingContext2D.prototype;
        const put = proto.putImageData;
        proto.putImageData = function (...args: Parameters<typeof put>) {
          if (args[0].width <= 64 && args[0].height <= 64) {
            (globalThis as any).__edgeCursor = { x: args[1], y: args[2] };
          }
          return put.apply(this, args);
        };
      });
      await page.mouse.move(box.x + 60, box.y + 80);
      await page.mouse.down();
      // Subpixel rounding at the right edge and captured motion below the
      // canvas must never deliver x == width or y == height to SDL.
      await page.mouse.move(box.x + box.width - 0.1, box.y + 80);
      await page.mouse.move(box.x + box.width - 1, box.y + box.height + 20);
      await page.mouse.up();
      await worker!.evaluate(() => { (globalThis as any).__edgeCursor = undefined; });
      await page.mouse.move(box.x + 120, box.y + 80);
      const status = await page.getByText(/\d+×\d+ · \d+ flips/).innerText();
      const [, width, height] = status.match(/(\d+)×(\d+)/)!;
      await expect.poll(async () => {
        const cursor = await worker!.evaluate(() => (globalThis as any).__edgeCursor);
        return cursor && Math.abs(cursor.x - 120 * Number(width) / box.width) <= 1
          && Math.abs(cursor.y - 80 * Number(height) / box.height) <= 1;
      }, { timeout: 15_000 }).toBe(true);
      // Hovering at an axis maximum must also retain focus, without a
      // pressed button or capture masking an out-of-window coordinate.
      await page.mouse.move(box.x + box.width - 0.1, box.y + 80);
      await worker!.evaluate(() => { (globalThis as any).__edgeCursor = undefined; });
      await page.mouse.move(box.x + 60, box.y + 80);
      await expect.poll(async () => {
        const cursor = await worker!.evaluate(() => (globalThis as any).__edgeCursor);
        return cursor && Math.abs(cursor.x - 60 * Number(width) / box.width) <= 1;
      }, { timeout: 15_000 }).toBe(true);
      await canvas(page).click({ position: await menuPosition(page, "options") });
      await waitForOptions(page);
      await page.screenshot({ path: `../../.context/freeciv-edge-cursor-${density}.png`, scale: "css" });
    });

    test("menu music reaches the shared audio output", async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "audio acceptance targets Chromium");
      test.setTimeout(150_000);
      await page.addInitScript(() => {
        const Original = globalThis.AudioWorkletNode;
        globalThis.AudioWorkletNode = class extends Original {
          constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
            super(context, name, options);
            if (name === "kandelo-pcm-output") {
              const analyser = context.createAnalyser();
              analyser.fftSize = 2048;
              this.connect(analyser);
              const probe = { context, peak: 0 };
              (globalThis as any).__freecivAudio = probe;
              const samples = new Float32Array(analyser.fftSize);
              setInterval(() => {
                analyser.getFloatTimeDomainData(samples);
                for (const sample of samples) probe.peak = Math.max(probe.peak, Math.abs(sample));
              }, 16);
            }
          }
        };
      });
      await gotoMachine(page, "freeciv");
      await running(page);
      await showGame(page);
      // A trusted gesture activates the machine's real AudioContext.
      await canvas(page).click({ position: { x: 60, y: 80 } });
      const audio = () => page.evaluate(() => {
        const probe = (globalThis as any).__freecivAudio;
        return { state: probe?.context.state, peak: probe?.peak ?? 0,
          sampleRate: probe?.context.sampleRate };
      });
      await expect.poll(async () => (await audio()).state, { timeout: 30_000 }).toBe("running");
      // Measure the production worklet's output, after Freeciv decoded its
      // shipped Ogg menu track and wrote through SDL_mixer and /dev/dsp.
      await expect.poll(async () => (await audio()).peak, { timeout: 30_000 }).toBeGreaterThan(0.01);
      console.log(`Freeciv audio ${density}x: ${JSON.stringify(await audio())}`);
      await page.screenshot({ path: `../../.context/freeciv-audio-menu-${density}.png`, scale: "css" });
    });

    test("New Game shows filtered nations and readable leader controls", async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "native dialog regression targets Chromium");
      test.setTimeout(150_000);
      await gotoMachine(page, "freeciv");
      await running(page);
      await showGame(page);
      const box = (await canvas(page).boundingBox())!;
      await waitForPanel(page, box.width - 60, box.height - 60);
      await nativeAction(page, async () => canvas(page).click({ position: await menuPosition(page, "new") }));
      await waitForPanel(page, 60, 80);
      await nativeAction(page, () => canvas(page).click({ position: {
        x: box.width - 165, y: box.height - 24,
      } }));
      await waitForNationPicker(page);
      // Core nations have sparse global IDs. Their first page must still
      // paint real flags immediately, without dragging or changing sets.
      const countPixels = async (x: number, y: number, width: number, height: number,
        kind: "flag" | "text") => {
        const png = await page.screenshot({ scale: "css", clip: {
          x: box.x + box.width / 2 + x, y: box.y + box.height / 2 + y, width, height,
        } });
        return page.evaluate(async ({ encoded, width, height, kind }) => {
          const bitmap = await createImageBitmap(new Blob([
            Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
          ], { type: "image/png" }));
          const ctx = new OffscreenCanvas(width, height).getContext("2d")!;
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          const pixels = ctx.getImageData(0, 0, width, height).data;
          let matches = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
            if (kind === "flag" ? Math.max(r, g, b) - Math.min(r, g, b) > 80
              : Math.max(r, g, b) < 100) matches++;
          }
          return matches;
        }, { encoded: png.toString("base64"), width, height, kind });
      };
      await expect.poll(() => countPixels(-300, -180, 180, 320, "flag"))
        .toBeGreaterThan(200);
      // Theme fonts and theme controls must remain readable together,
      // without independent font enlargement or compensating dimensions.
      await expect.poll(() => countPixels(195, 80, 100, 20, "text"))
        .toBeGreaterThan(20);
      const leaderButton = { x: box.width / 2 + 240, y: box.height / 2 + 86 };
      const leaderCrop = { x: box.x + box.width / 2 + 160,
        y: box.y + box.height / 2 + 68, width: 160, height: 40 };
      const previous = await page.screenshot({ scale: "css", clip: leaderCrop });
      await nativeAction(page, () => canvas(page).click({ position: leaderButton }));
      await page.mouse.move(box.x + 1100, box.y + 300);
      await expect.poll(async () => Buffer.compare(previous,
        await page.screenshot({ scale: "css", clip: leaderCrop }))).not.toBe(0);
      await expect.poll(() => countPixels(195, 80, 100, 20, "text"))
        .toBeGreaterThan(20);
      await page.screenshot({ path: `../../.context/freeciv-core-picker-fixed-${density}.png`, scale: "css" });
      // Select two different visible entries, then commit through the real
      // server. This exercises filtered row identity as well as painting.
      const selection = { x: box.x + box.width / 2 + 10,
        y: box.y + box.height / 2 - 85, width: 290, height: 70 };
      await nativeAction(page, () => canvas(page).click({ position: {
        x: box.width / 2 - 300, y: box.height / 2 - 225,
      } }));
      const first = await page.screenshot({ scale: "css", clip: selection });
      await nativeAction(page, () => canvas(page).click({ position: {
        x: box.width / 2 - 300, y: box.height / 2 - 125,
      } }));
      await expect.poll(async () => Buffer.compare(first,
        await page.screenshot({ scale: "css", clip: selection }))).not.toBe(0);
      await nativeAction(page, () => canvas(page).click({ position: {
        x: box.width / 2 + 388, y: box.height / 2 + 290,
      } }));
      await waitForNationPicker(page, false);
      // Set up a single starting Settler through the lobby's normal chat
      // command. Unit focus otherwise depends on the random initial stack.
      await nativeAction(page, () => canvas(page).click({ position: {
        x: 250, y: box.height - 82,
      } }));
      await page.keyboard.type("/set startunits c", { delay: 30 });
      await nativeAction(page, () => page.keyboard.press("Enter", { delay: 100 }));
      await page.keyboard.type("/set techlevel 0", { delay: 30 });
      await nativeAction(page, () => page.keyboard.press("Enter", { delay: 100 }));
      // Upstream's lobby editor repeats after Enter. Leave it explicitly
      // before activating Start; the port preserves that native behavior.
      await page.keyboard.press("Escape", { delay: 100 });
      await nativeAction(page, () => canvas(page).click({ position: {
        x: box.width - 50, y: box.height - 24,
      } }));
      // A dark in-game status strip distinguishes the world from the lobby.
      await expect.poll(() => countPixels(-200, -box.height / 2 + 7, 400, 14, "text"),
        { timeout: 60_000 }).toBeGreaterThan(2_000);
      await page.screenshot({ path: `../../.context/freeciv-native-new-game-fixed-${density}.png`, scale: "css" });
      writeFileSync("../../.context/freeciv-current-demo-url.txt", page.url());
      // Continue the first-turn flow: found a city and change production
      // through the native editor.
      await waitForPanel(page, box.width - 60, box.height - 60);
      await canvas(page).focus();
      await nativeAction(page, () => page.keyboard.press("b", { delay: 100 }));
      await waitForTitlebar(page, -40, -50);
      await nativeAction(page, () => page.keyboard.press("Enter", { delay: 100 }));
      await waitForPanel(page, box.width / 2 + 300, box.height / 2 + 200);
      await nativeAction(page, () => page.keyboard.press("c", { delay: 100 }));
      // Read the painted green commit icon in the editor's left header.
      // Its vertical position follows content metrics, not a fixed row.
      const commitIcon = async () => {
        const clip = { x: box.x + box.width / 2 - 455,
          y: box.y + box.height / 2 - 350, width: 190, height: 220 };
        const png = await page.screenshot({ scale: "css", clip });
        const point = await page.evaluate(async encoded => {
          const bitmap = await createImageBitmap(new Blob([
            Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
          ], { type: "image/png" }));
          const ctx = new OffscreenCanvas(190, 220).getContext("2d")!;
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          const pixels = ctx.getImageData(0, 0, 190, 220).data;
          let x = 0, y = 0, count = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
            if (r < 140 && g > 90 && g > r * 1.2 && g > b * 1.1) {
              x += (i / 4) % 190; y += Math.floor(i / 4 / 190); count++;
            }
          }
          return count > 10 ? { x: x / count, y: y / count } : null;
        }, png.toString("base64"));
        return point && { x: clip.x + point.x, y: clip.y + point.y };
      };
      await expect.poll(commitIcon).not.toBeNull();
      // The unmodified cards must retain clear bottom padding at the
      // shared display scale.
      await expect.poll(() => countPixels(-250, -190, 650, 2, "text")).toBe(0);
      await page.screenshot({ path: `../../.context/freeciv-production-fixed-${density}.png`, scale: "css" });
      // The first card is Barracks, or Aqueduct for a river city. With
      // zero random starting technologies, both are predictable choices.
      await nativeAction(page, () => canvas(page).click({ position: {
        x: box.width / 2 - 115, y: box.height / 2 - 200,
      } }));
      const commit = (await commitIcon())!;
      await nativeAction(page, () => page.mouse.click(commit.x, commit.y));
      await nativeAction(page, () => page.keyboard.press("Escape", { delay: 100 }));
      await waitForPanel(page, box.width / 2 + 300, box.height / 2 + 200, false);
      const command = async (value: string) => {
        await canvas(page).focus();
        await page.keyboard.press("Tab");
        await waitForChatInput(page);
        await page.keyboard.type(value, { delay: 20 });
        await page.keyboard.press("Enter", { delay: 100 });
      };
      await command("/set compresstype PLAIN");
      await command("/save production-check");
      const script = String.raw`
        BEGIN { FPAT = "([^,]+)|(\"[^\"]*\")" }
        /^\[player0\]/{human=1}
        /^\[/{if ($0 != "[player0]") human=0}
        human && /^nation[[:space:]]*=/{print "NATION:" $0}
        human && /^c=/{
          sub(/^c=\{/, ""); n=split($0,h,",")
          for(i=1;i<=n;i++){gsub(/[^a-z_]/,"",h[i]); c[h[i]]=i}
          rows=1; next
        }
        rows && /^}/{rows=0; next}
        rows {print $(c["currently_building_name"])}
      `;
      const production = await guestCommand(page,
        `save="$HOME/.freeciv/saves/production-check.sav"; attempts=0
         while [ ! -f "$save" ] && [ "$attempts" -lt 10 ]; do
           sleep 1; attempts=$((attempts + 1))
         done
         awk '${script}' "$save"`);
      expect(production).toMatch(/NATION:nation\s*=\s*"Apache"/);
      expect(production).toMatch(/"(?:Aqueduct(?:,[^"]*)?|Barracks)"/);
    });
    test("nation picker scrolling keeps accepting clicks", async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "native dialog regression targets Chromium");
      test.setTimeout(120_000);
      await gotoMachine(page, "freeciv");
      await running(page);
      await showGame(page);
      await multiplayer(page, "host");
      await expect.poll(() => terminalLines(page), { timeout: 60_000 })
        .toMatch(/has connected from (?:localhost|127\.0\.0\.1)/);
      await expect(page.getByTestId("kms-dock-action-status")).toHaveCount(0, { timeout: 30_000 });
      await showGame(page);
      const box = (await canvas(page).boundingBox())!;
      writeFileSync("../../.context/freeciv-current-demo-url.txt", page.url());
      await waitForPanel(page, 60, 80);
      await nativeAction(page, () => canvas(page).click({ position: {
        x: box.width - 165, y: box.height - 24,
      } }));
      await waitForNationPicker(page);
      await page.screenshot({ path: `../../.context/freeciv-nation-initial-${density}.png`, scale: "css" });
      // Switch Core -> Extended, matching the reported nation picker.
      await nativeAction(page, () => canvas(page).click({ position: {
        x: box.width / 2 + 299, y: box.height / 2 - 165,
      } }));
      await page.waitForTimeout(1000);
      // The server changes the available nations asynchronously. Reopen
      // after its reply so we test the newly available list.
      await nativeAction(page, () => canvas(page).click({ position: {
        x: box.width / 2 - 393, y: box.height / 2 + 290,
      } }));
      await waitForNationPicker(page, false);
      await nativeAction(page, () => canvas(page).click({ position: {
        x: box.width - 165, y: box.height - 24,
      } }));
      await waitForNationPicker(page);
      await page.screenshot({ path: `../../.context/freeciv-nation-extended-${density}.png`, scale: "css" });
      for (let attempt = 0; attempt < 3; attempt++) {
        const list = { x: box.x + box.width / 2 - 450, y: box.y + box.height / 2 - 265,
          width: 270, height: 480 };
        const before = await page.screenshot({ clip: list, scale: "css" });
        await page.mouse.move(box.x + box.width / 2 - 150, box.y + box.height / 2 - 228);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 - 150, box.y + box.height / 2 + 174, { steps: 12 });
        await page.mouse.up();
        await page.mouse.move(box.x + box.width / 2 + 300, box.y + box.height / 2);
        await page.screenshot({ path: `../../.context/freeciv-nation-dragged-${density}-${attempt}.png`, scale: "css" });
        let scrollFailure: unknown;
        try {
          await expect.poll(async () => Buffer.compare(before,
            await page.screenshot({ clip: list, scale: "css" })), { timeout: 10_000 }).not.toBe(0);
        } catch (error) { scrollFailure = error; }
        // A subsequent Cancel must leave the modal and restore lobby clicks.
        await nativeAction(page, () => canvas(page).click({ position: {
          x: box.width / 2 - 393, y: box.height / 2 + 290,
        } }));
        await waitForNationPicker(page, false);
        await page.screenshot({ path: `../../.context/freeciv-nation-cancelled-${density}-${attempt}.png`, scale: "css" });
        if (scrollFailure) throw scrollFailure;
        if (attempt < 2) {
          await nativeAction(page, () => canvas(page).click({ position: {
            x: box.width - 165, y: box.height - 24,
          } }));
          await waitForNationPicker(page);
        }
      }
    });
    test("clicking the display captures the pointer with a visible Escape hint", async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "trusted pointer lock regression targets Chromium");
      test.setTimeout(150_000);
      await gotoMachine(page, "freeciv");
      await running(page);
      await showGame(page, { pointerLock: true });
      await expect(page.getByTestId("kms-pointer-lock")).toHaveCount(0);
      await expect(page.getByRole("checkbox", { name: "Lock on click", exact: true })).toHaveCount(0);
      const captured = () => page.evaluate(() => document.pointerLockElement?.tagName ?? null);
      expect(await captured()).toBeNull();
      const box = (await canvas(page).boundingBox())!;
      // The initiating click must open Options before capture takes over.
      await canvas(page).click({ position: await menuPosition(page, "options") });
      await expect.poll(captured).toBe("CANVAS");
      await expect(page.getByTestId("kms-pointer-hint")).toHaveText("Pointer captured · Press Esc to release");
      await page.getByTestId("kms-pointer-hint").screenshot({
        path: `../../.context/freeciv-pointer-capture-hint-${density}.png`, scale: "css",
      });
      await waitForPanel(page, box.width / 2 + 100, box.height / 2 + 100);
      await page.screenshot({ path: `../../.context/freeciv-click-to-capture-${density}.png`, scale: "css" });
      await expect(page.getByTestId("kms-pointer-hint")).toBeHidden({ timeout: 6_000 });
      await page.keyboard.press("Escape");
      await expect.poll(captured).toBeNull();
      await waitForPanel(page, box.width / 2 + 100, box.height / 2 + 100, false);
      await canvas(page).click({ position: await menuPosition(page, "options") });
      await expect.poll(captured).toBe("CANVAS");
      await waitForPanel(page, box.width / 2 + 100, box.height / 2 + 100);
      await page.keyboard.press("Escape");
      await expect.poll(captured).toBeNull();
      // Touch input stays usable without trapping a device with no Escape key.
      const input = await page.context().newCDPSession(page);
      await input.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      const point = await menuPosition(page, "options");
      await input.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
        { id: 1, x: box.x + point.x, y: box.y + point.y },
      ] });
      await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await waitForPanel(page, box.width / 2 + 100, box.height / 2 + 100);
      expect(await captured()).toBeNull();
      await input.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await input.detach();
    });
    test("pointer lock pans the map and preserves clicks", async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "trusted pointer lock regression targets Chromium");
      test.setTimeout(240_000);
      await page.addInitScript(() => {
        (globalThis as any).__pointerTrace = [];
        const post = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (message: any, ...rest: any[]) {
          const records = message?.type === "input_event_batch_inject" ? message.records
            : message?.type === "input_event_inject" ? [message] : [];
          for (const event of records) {
            if (event.device === 1) (globalThis as any).__pointerTrace.push(event);
          }
          return Reflect.apply(post, this, [message, ...rest]);
        };
      });
      await gotoMachine(page, "freeciv");
      await running(page);
      await showGame(page);
      await multiplayer(page, "host");
      await expect.poll(() => terminalLines(page), { timeout: 60_000 })
        .toMatch(/has connected from (?:localhost|127\.0\.0\.1)/);
      await expect(page.getByTestId("kms-dock-action-status")).toHaveCount(0, { timeout: 30_000 });
      const box = (await canvas(page).boundingBox())!;
      await canvas(page).click({ position: { x: box.width - 50, y: box.height - 24 } });
      await expect.poll(() => terminalLines(page), { timeout: 60_000 }).toMatch(/rules the/);
      await showGame(page);
      await waitForPanel(page, 60, 80, false);
      await canvas(page).focus();
      await page.keyboard.press("c");
      const terrain = async () => {
        const png = await page.screenshot({ scale: "css", clip: {
          x: box.x + box.width / 2 - 150, y: box.y + box.height / 2 - 100, width: 300, height: 200,
        } });
        return page.evaluate(async encoded => {
          const bitmap = await createImageBitmap(new Blob([
            Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
          ], { type: "image/png" }));
          const ctx = new OffscreenCanvas(300, 200).getContext("2d")!;
          ctx.drawImage(bitmap, 0, 0); bitmap.close();
          const pixels = ctx.getImageData(0, 0, 300, 200).data;
          let count = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 16) count++;
          }
          return count;
        }, png.toString("base64"));
      };
      await expect.poll(terrain).toBeGreaterThan(5_000);
      await showGame(page, { pointerLock: true });
      // Capture on empty terrain: clicking the starting unit stack opens
      // Freeciv's unit picker, whose modal correctly disables edge scrolling.
      const capture = () => canvas(page).click({ position: { x: 120, y: 80 } });
      const captured = () => page.evaluate(() => document.pointerLockElement?.tagName ?? null);
      expect(await captured()).toBeNull();
      let mouseX = box.x + 120;
      let mouseY = box.y + 80;
      await capture();
      await expect.poll(captured).toBe("CANVAS");
      await expect(page.getByTestId("kms-pointer-hint")).toBeVisible();
      const move = async (dx: number, dy: number) => {
        // Chromium derives movementX/Y from consecutive protocol positions,
        // while the page's clientX/Y stay frozen at the capture point.
        mouseX += dx; mouseY += dy;
        await page.mouse.move(mouseX, mouseY);
      };
      const position = () => page.evaluate(() => {
        const events = (globalThis as any).__pointerTrace as { ev_type: number; code: number; value: number }[];
        // Decode the stable absolute-device range into the current scanout,
        // as the guest's cached evdev bounds do after a display mode change.
        const [, w, h] = document.body.innerText.match(/(\d+)×(\d+) · \d+ flips/)!.map(Number);
        return [w, h].map((extent, code) => {
          const value = events.filter(e => e.ev_type === 3 && e.code === code).at(-1)?.value;
          return value === undefined ? undefined : Math.floor(value * (extent - 1) / 65535);
        });
      });
      const status = await page.getByText(/\d+×\d+ · \d+ flips/).innerText();
      const [, width, height] = status.match(/(\d+)×(\d+)/)!.map(Number);
      const scale = Math.min(box.width / width, box.height / height);
      // Native relative events must reach the last valid pixel, stay there
      // through overshoot, and reverse immediately in the same guest grid.
      await move(100_000, -100_000);
      await expect.poll(position).toEqual([width - 1, 0]);
      await move(-12 * scale, 0);
      await expect.poll(position).toEqual([width - 13, 0]);
      for (let i = 0; i < 3; i++) await move(1, 0);
      await expect.poll(position).toEqual([width - 13 + Math.round(3 / scale), 0]);
      // Move to the middle of the northern edge. Actual terrain disappearing
      // proves the unmodified SDL edge-scroll loop runs while the OS is locked.
      await move(-(width / 2) * scale, 0);
      await expect.poll(terrain, { timeout: 30_000 }).toBeLessThan(10);
      await move(0, 100 * scale);
      await page.keyboard.press("c");
      await expect.poll(terrain).toBeGreaterThan(5_000);
      // Click a real native widget at the integrated position. Browser client
      // coordinates remain frozen while locked and must not retarget the click.
      const [px, py] = await position();
      await move((10 - px!) * scale, (10 - py!) * scale);
      await page.mouse.down(); await page.mouse.up();
      await waitForOptions(page);
      await page.screenshot({ path: `../../.context/freeciv-pointer-lock-${density}.png`, scale: "css" });
      await page.keyboard.press("Escape");
      await expect.poll(captured).toBeNull();

      await waitForOptions(page, false);
      await canvas(page).click({ position: { x: 16, y: 16 } });
      await waitForOptions(page);
      await page.keyboard.press("Escape");
      await waitForOptions(page, false);
      await capture();
      await expect.poll(captured).toBe("CANVAS");
      await page.mouse.down();
      // Leaving the pane must release capture and the guest's held button.
      await page.getByRole("button", { name: "Terminal", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
      await expect.poll(captured).toBeNull();
      await page.mouse.up();
      await expect.poll(() => page.evaluate(() => (globalThis as any).__pointerTrace
        .filter((e: any) => e.ev_type === 1 && e.code === 272).map((e: any) => e.value).slice(-2)))
        .toEqual([1, 0]);
      await showGame(page, { pointerLock: true });
      await capture();
      await expect.poll(captured).toBe("CANVAS");
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await expect.poll(captured).toBeNull();

      // A denied browser capability must remain visible, not appear captured.
      await canvas(page).evaluate(node => Object.defineProperty(node, "requestPointerLock", {
        configurable: true, value: () => Promise.reject(new DOMException("Denied", "NotAllowedError")),
      }));
      try {
        await capture();
        await expect(page.getByRole("alert")).toContainText("Pointer lock was denied");
        expect(await captured()).toBeNull();
      } finally {
        await canvas(page).evaluate(node => { delete (node as any).requestPointerLock; });
      }
    });
    test("map navigation and orders keep accepting clicks", async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "native map regression targets Chromium");
      test.setTimeout(180_000);
      page.setDefaultTimeout(15_000);
      await gotoMachine(page, "freeciv");
      await running(page);
      await showGame(page);
      await multiplayer(page, "host");
      await expect.poll(() => terminalLines(page), { timeout: 60_000 })
        .toMatch(/has connected from (?:localhost|127\.0\.0\.1)/);
      await expect(page.getByTestId("kms-dock-action-status")).toHaveCount(0, { timeout: 30_000 });
      await showGame(page);
      const box = (await canvas(page).boundingBox())!;
      await canvas(page).click({ position: { x: box.width - 50, y: box.height - 24 } });
      await expect.poll(() => terminalLines(page), { timeout: 60_000 }).toMatch(/rules the/);
      await showGame(page);
      await waitForPanel(page, 60, 80, false);
      const command = async (value: string) => {
        await canvas(page).focus();
        await page.keyboard.press("Tab");
        await waitForChatInput(page);
        await page.keyboard.type(value, { delay: 20 });
        await page.keyboard.press("Enter", { delay: 100 });
      };
      const readUnits = async (name: string) => {
        await command(`/save ${name}`);
        await page.screenshot({ path: `../../.context/freeciv-${name}-${density}.png`, scale: "css" });
        const script = String.raw`
          /^\[player0\]/{human=1}
          /^\[/{if ($0 != "[player0]") human=0}
          human && /^u=/{
            sub(/^u=\{/, ""); n=split($0,h,",")
            for(i=1;i<=n;i++){gsub(/[^a-z_]/,"",h[i]); c[h[i]]=i}
            rows=1; next
          }
          rows && /^}/{rows=0; next}
          rows {print $(c["id"]), $(c["x"]), $(c["y"]), $(c["go"]),
                      $(c["goto_x"]), $(c["goto_y"]), $(c["orders_length"])}
        `;
        // The server writes saves on a background thread.
        const summary = await guestCommand(page,
          `save="$HOME/.freeciv/saves/${name}.sav"; attempts=0
           while [ ! -f "$save" ] && [ "$attempts" -lt 10 ]; do
             sleep 1; attempts=$((attempts + 1))
           done
           awk -F, '${script}' "$save"`);
        await showGame(page);
        expect(summary).toMatch(/^[0-9]+ /m);
        return summary;
      };
      await command("/set compresstype PLAIN");
      const before = await readUnits("controls-before");
      await showGame(page);
      await canvas(page).focus();
      await nativeAction(page, () => page.keyboard.press("c"));
      const mapCenter = { x: box.x + box.width / 2 - 250,
        y: box.y + box.height / 2 - 150, width: 500, height: 300 };
      const centerTerrainPixels = async () => {
        const png = await page.screenshot({ clip: mapCenter, scale: "css" });
        return page.evaluate(async encoded => {
          const bitmap = await createImageBitmap(new Blob([
            Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
          ], { type: "image/png" }));
          const sample = new OffscreenCanvas(500, 300).getContext("2d")!;
          sample.drawImage(bitmap, 0, 0);
          const pixels = sample.getImageData(0, 0, 500, 300).data;
          bitmap.close();
          let terrain = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) terrain++;
          }
          return terrain;
        }, png.toString("base64"));
      };
      await expect.poll(centerTerrainPixels).toBeGreaterThan(5_000);
      // This overview point is far from the starting island. Observe the
      // map turn black, then C restore terrain: accepting a click alone
      // does not prove that minimap recentering actually worked.
      await canvas(page).click({ button: "right", position: await nativePosition(page, 5, -125) });
      await expect.poll(centerTerrainPixels, { timeout: 10_000 }).toBeLessThan(10);
      await page.screenshot({ path: `../../.context/freeciv-minimap-pan-${density}.png`, scale: "css" });
      await canvas(page).focus();
      await page.keyboard.press("c");
      await expect.poll(centerTerrainPixels).toBeGreaterThan(5_000);
      for (let i = 0; i < 12; i++) {
        await canvas(page).click({ button: "right", position: {
          x: box.width / 2 + (i % 2 ? -180 : 180), y: box.height / 2 - 60,
        } });
        await canvas(page).click({ button: "right", position: await nativePosition(page, 50 + (i % 3) * 15, -65) });
        await canvas(page).focus();
        await page.keyboard.press("c");
        await canvas(page).click({ position: { x: 16, y: 16 } });
        await waitForOptions(page);
        await page.keyboard.press("Escape");
        await waitForOptions(page, false);
        if (i % 3 === 0) await page.screenshot({ path: `../../.context/freeciv-navigation-${density}-${i}.png`, scale: "css" });
      }
      for (let i = 0; i < 3; i++) {
        await canvas(page).click({ button: "right", delay: 750,
          position: { x: box.width / 2 + 64, y: box.height / 2 } });
        await page.screenshot({ path: `../../.context/freeciv-map-context-${density}-${i}.png`, scale: "css" });
        await page.keyboard.press("Escape");
        await canvas(page).click({ position: { x: 16, y: 16 } });
        await waitForOptions(page);
        await page.keyboard.press("Escape");
        await waitForOptions(page, false);
      }
      // Mouse motion and Escape can remain live even if button state is
      // stranded. Interrupt a map gesture, then require an actual menu click.
      for (const release of ["pointercancel", "lostpointercapture", "blur"] as const) {
        await page.mouse.move(box.x + box.width / 2 + 180, box.y + box.height / 2 - 60);
        await page.mouse.down({ button: "right" });
        if (release === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        else await canvas(page).dispatchEvent(release, { pointerId: 1, pointerType: "mouse" });
        await page.mouse.up({ button: "right" });
        await canvas(page).click({ position: { x: 16, y: 16 } });
        await waitForOptions(page);
        await page.keyboard.press("Escape");
        await waitForOptions(page, false);
      }
      const after = await readUnits("controls-after");
      expect(after).toBe(before); // Panning must not move units or assign routes.
      writeFileSync(`../../.context/freeciv-navigation-saves-${density}.txt`, `${before}\n${after}`);
      await canvas(page).focus();
      await nativeAction(page, () => page.keyboard.press("g"));
      for (let i = 0; i < 60; i++) {
        await page.mouse.move(box.x + 220 + (i % 20) * 40,
          box.y + 260 + Math.floor(i / 20) * 70);
      }
      await canvas(page).click({ button: "left",
        position: { x: 50, y: box.height - 65 } });
      await canvas(page).click({ button: "right",
        position: { x: box.width / 2 + 150, y: box.height / 2 - 50 } });
      expect(await readUnits("controls-preview")).toBe(before);
      await canvas(page).focus();
      await page.mouse.move(box.x + box.width / 2 + 220, box.y + box.height / 2 - 80);
      await page.keyboard.press("Escape");
      // A native chat/save round-trip is an input-consumption barrier.
      expect(await readUnits("controls-cancel")).toBe(before);
      await page.screenshot({ path: `../../.context/freeciv-goto-escape-${density}.png`, scale: "css" });
      // Escape cancels the pending destination, rather than opening Options.
      await waitForOptions(page, false);
      await canvas(page).click({ position: {
        x: box.width / 2 + 220, y: box.height / 2 - 80,
      } });
      // A later selection click must not commit the cancelled destination.
      expect(await readUnits("controls-click")).toBe(before);

    });
    for (const inGame of [false, true]) {
      test(`quit ${inGame ? "an active game" : "the main menu"} returns to the shell`, async ({ page, browserName }) => {
        test.skip(browserName !== "chromium", "graphical lifecycle targets Chromium");
        test.setTimeout(180_000);
        await gotoMachine(page, "freeciv");
        await running(page);
        await showGame(page);
        const box = (await canvas(page).boundingBox())!;
        await waitForPanel(page, box.width - 60, box.height - 60);
        if (inGame) {
          await multiplayer(page, "host");
          await expect.poll(() => terminalLines(page), { timeout: 60_000 })
            .toMatch(/has connected from (?:localhost|127\.0\.0\.1)/);
          await expect(page.getByTestId("kms-dock-action-status")).toHaveCount(0, { timeout: 30_000 });
          await canvas(page).click({ position: { x: box.width - 50, y: box.height - 24 } });
          await expect.poll(() => terminalLines(page), { timeout: 60_000 }).toMatch(/rules the/);
          await showGame(page);
          // Observe actual map pixels before opening its options.
          await expect.poll(async () => (await page.screenshot({ clip: {
            x: box.x + 40, y: box.y + 60, width: 40, height: 30,
          } })).byteLength, { timeout: 30_000 }).toBeLessThan(300);
          await canvas(page).focus();
          await page.keyboard.press("Escape");
          await waitForPanel(page, box.width / 2 + 100, box.height / 2 + 100);
          await page.screenshot({ path: `../../.context/freeciv-quit-options-${density}.png`, scale: "css" });
          // Click the native settings dialog's bottom Quit entry.
          await canvas(page).click({ position: { x: box.width / 2, y: box.height / 2 + 171 } });
        } else {
          await canvas(page).click({ position: await menuPosition(page, "quit") });
        }
        await page.screenshot({ path: `../../.context/freeciv-quit-after-${density}-${inGame}.png`, scale: "css" });
        await expect.poll(() => terminalLines(page), { timeout: 20_000 })
          .toMatch(/kandelo\$\s*$/);
        await page.getByRole("button", { name: "Terminal", exact: true }).click();
        const slot = page.locator(".kshell-terminal-slot:not([hidden])");
        await slot.locator(".xterm-screen").click();
        await page.keyboard.insertText('printf "FREECIV_EXIT=%s\\n" "$?"');
        await page.keyboard.press("Enter");
        await expect.poll(() => slot.locator(".xterm-rows").innerText()).toMatch(/FREECIV_EXIT=0/);
        const processes = await guestCommand(page,
          'for p in /proc/[0-9]*/cmdline; do tr "\\0" " " < "$p" 2>/dev/null; echo; done');
        expect(processes).not.toMatch(/\/usr\/libexec\/freeciv\/(?:client|server)\.wasm/);
      });
    }
    test("cursor rendering reuses the scene texture", async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "graphical workload targets Chromium");
      test.setTimeout(240_000);
      await gotoMachine(page, "freeciv");
      await running(page);
      await showGame(page);
      const box = (await canvas(page).boundingBox())!;
      await waitForPanel(page, box.width - 60, box.height - 60);
      await nativeAction(page, () => page.mouse.move(box.x + 160, box.y + 100));
      // Instrument the normal WebGL API in the kernel worker, without
      // replacing any guest or host rendering behavior. This probe counts
      // actual uploads and presentations, rather than inferring them from FPS.
      const workers = page.workers();
      const worker = workers.find(worker => /browser-kernel-worker-entry/.test(worker.url()));
      expect(worker, workers.map(worker => worker.url()).join("\n")).toBeTruthy();
      await worker!.evaluate(() => {
        const state = {
          uploadBytes: 0, sceneUploadBytes: 0, texturesCreated: 0,
          presents: [] as number[], cursorPresents: [] as number[],
        };
        (globalThis as any).__freecivRenderProbe = state;
        const cursorProto = OffscreenCanvasRenderingContext2D.prototype;
        const put = cursorProto.putImageData;
        cursorProto.putImageData = function (...args: Parameters<typeof put>) {
          if (args[0].width <= 64 && args[0].height <= 64) {
            state.cursorPresents.push(performance.timeOrigin + performance.now());
          }
          return put.apply(this, args);
        };
        const proto = WebGL2RenderingContext.prototype;
        const upload = proto.texSubImage2D;
        proto.texSubImage2D = function (...args: any[]) {
          if (typeof args[4] === "number" && typeof args[5] === "number") {
            const bytes = args[4] * args[5] * 4;
            state.uploadBytes += bytes;
            if (args[4] > 256) state.sceneUploadBytes += bytes;
          }
          return Reflect.apply(upload, this, args);
        } as typeof upload;
        const create = proto.createTexture;
        proto.createTexture = function () {
          state.texturesCreated++;
          return create.call(this);
        };
        const present = proto.blitFramebuffer;
        proto.blitFramebuffer = function (...args: Parameters<typeof present>) {
          state.presents.push(performance.timeOrigin + performance.now());
          return present.apply(this, args);
        };
      });
      // Feed the same two-second sweep at browser animation-frame cadence
      // on each build. Keep these instrumented counts separate from claims
      // about uninstrumented input latency or general Kandelo performance.
      const start = await page.evaluate(() => performance.timeOrigin + performance.now());
      for (let i = 0; i < 120; i++) {
        await page.mouse.move(box.x + 160 + (i % 60) * 4, box.y + 100 + Math.floor(i / 60) * 40);
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
      }
      const end = await page.evaluate(() => performance.timeOrigin + performance.now());
      const metrics = await worker!.evaluate(({ start, end }) => {
        const state = (globalThis as any).__freecivRenderProbe;
        const times = (state.cursorPresents as number[]).filter(time => time >= start && time <= end);
        const gaps = times.slice(1).map((time, i) => time - times[i]).sort((a, b) => a - b);
        return {
          uploadBytes: state.uploadBytes, sceneUploadBytes: state.sceneUploadBytes,
          texturesCreated: state.texturesCreated, presentations: times.length,
          elapsedMs: end - start, gapP50Ms: gaps[Math.floor(gaps.length * 0.5)] ?? null,
          gapP95Ms: gaps[Math.floor(gaps.length * 0.95)] ?? null,
          maxGapMs: gaps.at(-1) ?? null,
        };
      }, { start, end });
      const label = process.env.KANDELO_FREECIV_PROBE ?? "regression";
      // Serial Playwright mouse.move calls wait for browser input acks and
      // can themselves cap the first phase near 30 Hz. Feed a second sweep
      // at browser RAF cadence without waiting for each ack to distinguish
      // the renderer's pacing from that automation limit.
      await worker!.evaluate(() => {
        const state = (globalThis as any).__freecivRenderProbe;
        state.uploadBytes = state.sceneUploadBytes = state.texturesCreated = 0;
        state.presents = []; state.cursorPresents = [];
      });
      const input = await page.context().newCDPSession(page);
      const deliveries: Promise<unknown>[] = [];
      await page.exposeFunction("freecivProbeMove", (x: number, y: number) => {
        deliveries.push(input.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }));
      });
      const pacedStart = await page.evaluate(() => performance.timeOrigin + performance.now());
      await page.evaluate(async ({ x, y }) => {
        for (let i = 0; i < 120; i++) {
          void (globalThis as any).freecivProbeMove(x + 160 + (i % 60) * 4,
            y + 100 + Math.floor(i / 60) * 40);
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
      }, box);
      await Promise.all(deliveries);
      const pacedEnd = await page.evaluate(() => performance.timeOrigin + performance.now());
      const paced = await worker!.evaluate(({ start, end }) => {
        const state = (globalThis as any).__freecivRenderProbe;
        const times = (state.cursorPresents as number[]).filter(time => time >= start && time <= end);
        const gaps = times.slice(1).map((time, i) => time - times[i]).sort((a, b) => a - b);
        return { uploadBytes: state.uploadBytes, texturesCreated: state.texturesCreated,
          presentations: times.length, elapsedMs: end - start,
          gapP50Ms: gaps[Math.floor(gaps.length * 0.5)] ?? null,
          gapP95Ms: gaps[Math.floor(gaps.length * 0.95)] ?? null,
          maxGapMs: gaps.at(-1) ?? null };
      }, { start: pacedStart, end: pacedEnd });
      await input.detach();
      // A third phase sends a burst, then opens Options through normal
      // input. Seeing that dialog proves the queued motion was consumed.
      // This end-to-end measure includes Playwright and screenshot sampling.
      await worker!.evaluate(() => {
        const state = (globalThis as any).__freecivRenderProbe;
        state.uploadBytes = state.sceneUploadBytes = state.texturesCreated = 0;
        state.presents = []; state.cursorPresents = [];
      });
      const center = { x: box.x + box.width / 2 - 40, y: box.y + box.height / 2 - 20,
        width: 80, height: 40 };
      const beforeDialog = await page.screenshot({ clip: center, scale: "css" });
      const burstStart = Date.now();
      for (let i = 0; i < 120; i++) {
        await page.mouse.move(box.x + 160 + (i % 60) * 4, box.y + 100 + Math.floor(i / 60) * 40);
      }
      await canvas(page).click({ position: await menuPosition(page, "options") });
      await expect.poll(async () => Buffer.compare(beforeDialog,
        await page.screenshot({ clip: center, scale: "css" })), { timeout: 60_000 }).not.toBe(0);
      const burstMs = Date.now() - burstStart;
      const burst = await worker!.evaluate(() => {
        const state = (globalThis as any).__freecivRenderProbe;
        return { uploadBytes: state.uploadBytes, sceneUploadBytes: state.sceneUploadBytes,
          texturesCreated: state.texturesCreated, presentations: state.presents.length };
      });
      const archiveModule = await (await page.request.get(
        "/@id/__x00__kandelo-source-only-asset:programs%2Fwasm32%2Ffreeciv.zip?import",
      )).text();
      const result = { ...metrics, paced, burst: { ...burst, observedMs: burstMs },
        density, browser: page.context().browser()!.version(), viewport: page.viewportSize(),
        archive: archiveModule.match(/export default "([^"]+)"/)?.[1] };
      writeFileSync(`../../.context/freeciv-render-${label}-${density}.json`, JSON.stringify(result, null, 2));
      console.log(`Cursor rendering ${label} ${density}x: ${JSON.stringify(result)}`);
      if (label !== "before") {
        expect(metrics.presentations).toBeGreaterThan(20);
        expect(metrics.sceneUploadBytes).toBe(0);
        expect(metrics.texturesCreated).toBe(0);
      }
    });
    test("game cursor and unit panel remain readable", async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "graphical acceptance targets Chromium");
      test.setTimeout(240_000);
      await gotoMachine(page, "freeciv");
      await running(page);
      await showGame(page);
      await multiplayer(page, "host");
      await expect.poll(() => terminalLines(page), { timeout: 90_000 })
        .toMatch(/has connected from (?:localhost|127\.0\.0\.1)/);
      await expect(page.getByTestId("kms-dock-action-status")).toHaveCount(0, { timeout: 30_000 });
      const box = (await canvas(page).boundingBox())!;
      await canvas(page).click({ position: { x: box.width - 50, y: box.height - 24 } });
      await expect.poll(() => terminalLines(page), { timeout: 90_000 }).toMatch(/rules the/);
      await showGame(page);
      // The server announces players before the client has replaced its
      // lobby with the map. Observe that actual scene transition first.
      await waitForPanel(page, 60, 80, false);
      // The uncharted top-left is stable black. Browser screenshots omit
      // the OS pointer: changed pixels here prove a guest-rendered cursor.
      const clip = { x: box.x + 60, y: box.y + 80, width: 30, height: 35 };
      const cursorPixels = async () => {
        const png = await page.screenshot({ clip, scale: "css" });
        return page.evaluate(async encoded => {
          const bitmap = await createImageBitmap(new Blob([
            Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
          ], { type: "image/png" }));
          const context = new OffscreenCanvas(30, 35).getContext("2d")!;
          context.drawImage(bitmap, 0, 0);
          const pixels = context.getImageData(0, 0, 30, 35).data;
          bitmap.close();
          let lit = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            // Brave's canvas privacy protection can perturb black by a
            // low bit; count visible ink rather than exact nonzero bytes.
            if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 16) lit++;
          }
          return lit;
        }, png.toString("base64"));
      };
      await page.mouse.move(box.x + 120, box.y + 80);
      await expect.poll(cursorPixels, { timeout: 15_000 }).toBe(0);
      // Bitmap controls must keep their CSS size too. This point lies in
      // the minimap toolbar at 1x; a font-only DPI fix leaves it black at 2x.
      const toolbarPoint = await nativePosition(page, 180, -40);
      await waitForPanel(page, toolbarPoint.x, toolbarPoint.y);
      await page.screenshot({ path: `../../.context/freeciv-minimap-${density}.png`, scale: "css", clip: {
        x: box.x, y: box.y + box.height - 240, width: 330, height: 240,
      } });
      await page.mouse.move(clip.x, clip.y);
      await expect.poll(cursorPixels, { timeout: 15_000 }).toBeGreaterThan(10);
      await page.screenshot({ path: `../../.context/freeciv-cursor-game-${density}.png`, scale: "css" });
      await page.mouse.move(box.x + box.width - 0.1, box.y + 80);
      await page.getByRole("button", { name: "Terminal", exact: true }).click();
      await showGame(page);
      await page.mouse.move(clip.x, clip.y);
      await expect.poll(cursorPixels, { timeout: 15_000 }).toBeGreaterThan(10);

      await page.mouse.move(box.x + 120, box.y + 80);
      await expect.poll(cursorPixels, { timeout: 15_000 }).toBe(0);
      // SDL pointer coordinates and raw DRM image origins have different
      // semantics. Freeciv's shipped color sprites use a (16,16) hotspot.
      // Changing shape without moving the mouse must preserve its target.
      const worker = page.workers().find(worker => /browser-kernel-worker-entry/.test(worker.url()));
      expect(worker).toBeTruthy();
      await worker!.evaluate(() => {
        const proto = OffscreenCanvasRenderingContext2D.prototype;
        const put = proto.putImageData;
        proto.putImageData = function (...args: Parameters<typeof put>) {
          if (args[0].width <= 64 && args[0].height <= 64) {
            (globalThis as any).__cursorOrigin = { x: args[1], y: args[2] };
          }
          return put.apply(this, args);
        };
      });
      const originNear = async (x: number, y: number) => {
        const point = await worker!.evaluate(() => (globalThis as any).__cursorOrigin);
        return { point, near: !!point && Math.abs(point.x - x) <= 1 && Math.abs(point.y - y) <= 1 };
      };
      const target = await nativePosition(page, 600, 160);
      await page.mouse.move(box.x + target.x, box.y + target.y);
      await expect.poll(() => originNear(600, 160)).toMatchObject({ near: true });
      await canvas(page).focus();
      await page.keyboard.press("g");
      await expect.poll(() => originNear(584, 144)).toMatchObject({ near: true });
      await page.screenshot({ path: `../../.context/freeciv-color-cursor-${density}.png`, scale: "css" });
      await page.keyboard.press("Escape");
      await expect.poll(() => originNear(600, 160)).toMatchObject({ near: true });

      // Unmodified theme fonts and artwork must fit the unit panel together;
      // its text rows must remain separate at the shared display scale.
      const panel = await page.screenshot({ scale: "css", clip: {
        x: box.x + box.width - 260, y: box.y + box.height - 350, width: 260, height: 350,
      } });
      const metrics = await page.evaluate(async encoded => {
        const bitmap = await createImageBitmap(new Blob([
          Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
        ], { type: "image/png" }));
        const context = new OffscreenCanvas(260, 350).getContext("2d")!;
        context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, 260, 350).data;
        bitmap.close();
        const warm = (x: number, y: number) => {
          const i = (y * 260 + x) * 4;
          return pixels[i] > 160 && pixels[i + 1] > 140 && pixels[i + 2] > 110;
        };
        let top = 350;
        for (let y = 0; y < 350; y++) if (warm(254, y)) { top = y; break; }
        const bands: number[] = [];
        let inBand = false;
        for (let y = top + 4; y < 340; y++) {
          let dark = 0;
          for (let x = 120; x < 245; x++) {
            const i = (y * 260 + x) * 4;
            if (pixels[i] < 110 && pixels[i + 1] < 110 && pixels[i + 2] < 110) dark++;
          }
          if (dark >= 4) {
            if (!inBand) bands.push(0);
            bands[bands.length - 1]++;
            inBand = true;
          } else inBand = false;
        }
        return { height: 350 - top, bands };
      }, panel.toString("base64"));
      console.log(`Unit panel ${density}x: ${JSON.stringify(metrics)}`);
      expect(metrics.height).toBeGreaterThanOrEqual(120);
      expect(metrics.bands.length).toBeGreaterThanOrEqual(4);
      // At the default 10-point setting a merged pair of text rows would
      // span more than 20 CSS pixels, at either native display density.
      expect(Math.max(...metrics.bands)).toBeLessThanOrEqual(20);
      await page.screenshot({ path: `../../.context/freeciv-unit-panel-${density}.png`, scale: "css", clip: {
        x: box.x + box.width - 260, y: box.y + box.height - 350, width: 260, height: 350,
      } });
      // Exercise the actual unit-cycle and end-turn controls shown to users.
      const unitClip = { x: box.x + box.width - 180, y: box.y + box.height - 145,
        width: 170, height: 80 };
      await page.mouse.move(box.x + 250, box.y + 100);
      const firstUnit = await page.screenshot({ clip: unitClip, scale: "css" });
      await canvas(page).focus();
      await nativeAction(page, () => page.keyboard.press("w"));
      await expect.poll(async () => Buffer.compare(firstUnit,
        await page.screenshot({ clip: unitClip, scale: "css" }))).not.toBe(0);
      const header = { x: box.x + 300, y: box.y + 3, width: 700, height: 18 };
      for (const endTurn of [
        async () => canvas(page).click({ position: await nativePosition(page, 168, -118) }),
        () => page.keyboard.press("Shift+Enter", { delay: 100 }),
      ]) {
        const beforeTurn = await page.screenshot({ clip: header, scale: "css" });
        await nativeAction(page, endTurn);
        await expect.poll(async () => Buffer.compare(beforeTurn,
          await page.screenshot({ clip: header, scale: "css" })), { timeout: 30_000 }).not.toBe(0);
      }

    });
    test("screen resolution choices resize the game and retain working controls", async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "graphical acceptance targets Chromium");
      test.setTimeout(240_000);
      await gotoMachine(page, "freeciv");
      await running(page);
      await showGame(page);
      await expect(page.getByText("960×540", { exact: false })).toBeVisible();
      const click = async (x: number, y: number) => nativeAction(page,
        async () => canvas(page).click({ position: await nativePosition(page, x, y) }));
      const openInterface = async (width: number, height: number, inGame = false) => {
        await click(inGame ? 10 : width - 100, inGame ? 10 : height - 55);
        let box = (await canvas(page).boundingBox())!;
        await waitForPanel(page, box.width / 2 + 100, box.height / 2 + 100);
        await click(width / 2, height / 2 - 96); // Local options.
        await waitForPanel(page, box.width / 2 - 145, box.height / 2, false);
        await click(width / 2, height / 2 + 9); // Interface.
        await waitForPanel(page, box.width / 2 - 200, box.height / 2);
        box = (await canvas(page).boundingBox())!;
        const thumb = await nativePosition(page, width / 2 + 233, height / 2 - 91);
        const bottom = await nativePosition(page, width / 2 + 233, height / 2 + 137);
        // Wait for the actual resolution field's long horizontal border,
        // rather than an intermediate frame halfway through the drag.
        await page.mouse.move(box.x + thumb.x, box.y + thumb.y);
        await page.mouse.down();
        await page.mouse.move(box.x + bottom.x, box.y + bottom.y, { steps: 6 });
        await page.mouse.up();
        await expect.poll(async () => {
          const png = await page.screenshot({ scale: "css", clip: {
            x: box.x + (width / 2 + 105) * box.width / width,
            y: box.y + (height / 2 + 100) * box.height / height,
            width: 105 * box.width / width, height: 25 * box.height / height,
          } });
          return page.evaluate(async encoded => {
            const bitmap = await createImageBitmap(new Blob([
              Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
            ], { type: "image/png" }));
            const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
            ctx.drawImage(bitmap, 0, 0);
            const { width, height } = bitmap;
            bitmap.close();
            const pixels = ctx.getImageData(0, 0, width, height).data;
            for (let y = 0; y < height; y++) {
              let dark = 0;
              for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) < 140) dark++;
              }
              if (dark > width * 0.8) return true;
            }
            return false;
          }, png.toString("base64"));
        }).toBe(true);
      };
      await openInterface(960, 540);
      const choicesClip = { x: 880, y: 220, width: 130, height: 200 };
      const beforeChoices = await page.screenshot({ scale: "css", clip: choicesClip });
      await click(635, 383); // Screen resolution dropdown.
      await expect.poll(async () => Buffer.compare(beforeChoices,
        await page.screenshot({ scale: "css", clip: choicesClip }))).not.toBe(0);
      await page.screenshot({ path: `../../.context/freeciv-resolution-choices-${density}.png`, scale: "css" });
      // SDL orders the 17 standard modes from largest to smallest. The
      // dropdown opens upward by 17 rows of 15 guest pixels.
      await click(635, 351); // 800x600.
      await click(691, 92); // Apply through the native titlebar checkmark.
      await expect(page.getByText("800×600", { exact: false })).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: `../../.context/freeciv-resolution-800-${density}.png`, scale: "css" });
      // Apply returns to the category picker. Leave both option levels
      // before exercising the relocated main-menu button.
      for (let i = 0; i < 2; i++) await page.keyboard.press("Escape", { delay: 100 });
      // Reopen settings after the aspect change: this proves pointer
      // coordinates, hit testing and the resized window agree.
      await openInterface(800, 600);
      await click(555, 413);
      await click(555, 336); // 1280x720, row 12, menu top at 149.
      await click(611, 122);
      await expect(page.getByText("1280×720", { exact: false })).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: `../../.context/freeciv-resolution-1280-${density}.png`, scale: "css" });
      for (let i = 0; i < 2; i++) await page.keyboard.press("Escape", { delay: 100 });
      await click(1180, 665); // Options remains clickable at the new mode.
      const box = (await canvas(page).boundingBox())!;
      await waitForPanel(page, box.width / 2 + 50, box.height / 2 + 50);
      await click(640, 358); // Save Local Options.
      const settings = await guestCommand(page,
        'grep "gui_sdl2_screen" "$HOME/.freeciv/freeciv-client-rc-3.2"');
      expect(settings).toMatch(/1280/);
      expect(settings).toMatch(/720/);
      await multiplayer(page, "local");
      await showGame(page);
      await expect(page.getByText("1280×720", { exact: false })).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: `../../.context/freeciv-resolution-restored-${density}.png`, scale: "css" });
      // Start an actual game at the saved mode, then change resolution
      // while its map and unit panels are live.
      await multiplayer(page, "host");
      await expect.poll(() => terminalLines(page), { timeout: 60_000 })
        .toMatch(/has connected from (?:localhost|127\.0\.0\.1)/);
      await showGame(page);
      const lobby = (await canvas(page).boundingBox())!;
      await canvas(page).click({ position: { x: lobby.width - 50, y: lobby.height - 24 } });
      await expect.poll(() => terminalLines(page), { timeout: 60_000 }).toMatch(/rules the/);
      await showGame(page);
      await openInterface(1280, 720, true);
      await click(795, 473);
      await click(795, 426); // 960x540, row 14, menu top at 209.
      await click(851, 182);
      await expect(page.getByText("960×540", { exact: false })).toBeVisible({ timeout: 30_000 });
      for (let i = 0; i < 2; i++) await page.keyboard.press("Escape", { delay: 100 });
      await click(10, 10);
      const game = (await canvas(page).boundingBox())!;
      await waitForPanel(page, game.width / 2 + 50, game.height / 2 + 50);
      await page.keyboard.press("Escape", { delay: 100 });
      await page.screenshot({ path: `../../.context/freeciv-resolution-game-${density}.png`, scale: "css" });

    });
    test("font settings accept typed digits", async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "graphical acceptance targets Chromium");
      test.setTimeout(240_000);
      await gotoMachine(page, "freeciv");
      await running(page);
      await showGame(page);
      const display = await canvas(page).boundingBox();
      expect(display).not.toBeNull();
      expect(await page.evaluate(() => devicePixelRatio)).toBe(density);
      // The virtual monitor stays readable at both physical densities; fonts
      // and bitmap widgets use the same unmodified guest coordinate grid.
      await expect(page.getByText(`960×540`, { exact: false })).toBeVisible();
      // A narrow menu here would mean text shrank with device density.
      await waitForPanel(page, display!.width - 60, display!.height - 60);
      await page.screenshot({ path: `../../.context/freeciv-density-${density}.png`, scale: "css" });
      // Options is the second entry from the bottom of Freeciv's menu.
      await nativeAction(page, async () => canvas(page).click({ position: await menuPosition(page, "options") }));
      await waitForPanel(page, display!.width / 2 + 100, display!.height / 2 + 100);
      await page.screenshot({ path: `../../.context/freeciv-options-${density}.png`, scale: "css" });
      await nativeAction(page, () => canvas(page).click({ position: {
        x: display!.width / 2, y: display!.height / 2 - 144,
      } }));
      await waitForPanel(page, display!.width / 2 - 145, display!.height / 2, false);
      await page.screenshot({ path: `../../.context/freeciv-categories-${density}.png`, scale: "css" });
      await nativeAction(page, () => canvas(page).click({ position: {
        x: display!.width / 2, y: display!.height / 2 + 149,
      } }));
      await waitForPanel(page, display!.width / 2 - 200, display!.height / 2);
      await page.screenshot({ path: `../../.context/freeciv-fonts-${density}.png`, scale: "css" });
      // Drag away and back before editing. SDL mouse-state reads and
      // events must use the same guest display coordinates.
      const title = { x: display!.x + display!.width / 2,
        y: display!.y + display!.height / 2 - 131 };
      for (const [from, to] of [
        [title, { x: title.x + 30, y: title.y + 20 }],
        [{ x: title.x + 30, y: title.y + 20 }, title],
      ]) {
        await nativeAction(page, async () => {
          await page.mouse.move(from.x, from.y);
          await page.mouse.down();
          await page.mouse.move(to.x, to.y, { steps: 3 });
          await page.mouse.up();
        });
        await waitForPanel(page, display!.width / 2 - 220,
          display!.height / 2 - 146, to.x === title.x);
      }
      // A cancelled/capture-lost gesture or leaving the browser must end a
      // native drag even though no DOM pointerup reaches the canvas.
      const content = { x: display!.x + display!.width / 2 - 100,
        y: display!.y + display!.height / 2 - 50, width: 100, height: 60 };
      for (const release of ["pointercancel", "lostpointercapture", "blur"] as const) {
        const original = await page.screenshot({ clip: content, scale: "css" });
        await page.mouse.move(title.x, title.y);
        await page.mouse.down();
        if (release === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        else await canvas(page).dispatchEvent(release, { pointerId: 1, pointerType: "mouse" });
        await nativeAction(page, () => page.mouse.move(title.x + 130, title.y + 75, { steps: 4 }));
        await expect.poll(async () => Buffer.compare(original,
          await page.screenshot({ clip: content, scale: "css" }))).toBe(0);
        await page.mouse.up();
      }
      const fieldX = display!.width / 2 + 150;
      await nativeAction(page, () => canvas(page).click({ position: {
        x: fieldX, y: display!.height / 2 + 37,
      } })); // Disable theme size so the custom base size takes effect.
      await nativeAction(page, () => canvas(page).click({ position: {
        x: fieldX, y: display!.height / 2 + 80,
      } }));
      await nativeAction(page, async () => {
        await page.keyboard.press("End");
        await page.keyboard.press("Backspace", { delay: 100 });
        await page.keyboard.press("Backspace", { delay: 100 });
        await page.keyboard.type("14", { delay: 100 });
        await page.keyboard.press("Enter", { delay: 100 });
      });
      await page.screenshot({ path: `../../.context/freeciv-font-edited-${density}.png`, scale: "css" });
      await page.screenshot({ path: `../../.context/freeciv-font-setting-${density}.png`, scale: "css", clip: {
        x: display!.x + display!.width / 2 - 200,
        y: display!.y + display!.height / 2 - 125,
        width: 400, height: 250,
      } });
      // Apply through Freeciv's green check in the native title bar.
      await nativeAction(page, () => canvas(page).click({ position: {
        x: display!.width / 2 + 174,
        y: display!.height / 2 - 131,
      } }));
      await waitForPanel(page, display!.width / 2 - 200, display!.height / 2, false);
      await nativeAction(page, () => page.keyboard.press("Escape", { delay: 100 }));
      await waitForPanel(page, display!.width / 2 - 100, display!.height / 2);
      await nativeAction(page, () => canvas(page).click({ position: {
        x: display!.width / 2, y: display!.height / 2 - 3,
      } })); // Save Local Options.
      const settings = await guestCommand(page,
        'grep "gui_sdl2_.*font_size" "$HOME/.freeciv/freeciv-client-rc-3.2"');
      expect(settings).toMatch(/gui_sdl2_font_size\s*=\s*14\b/);
      expect(settings).toMatch(/gui_sdl2_use_theme_font_size\s*=\s*false/i);
      await showGame(page);
      await multiplayer(page, "local");
      await showGame(page);
      await waitForPanel(page, display!.width - 60, display!.height - 60);
      await expect(page.getByTestId("kms-dock-action-status")).toHaveCount(0, { timeout: 30_000 });
      await page.screenshot({ path: `../../.context/freeciv-custom-font-${density}.png`, scale: "css" });
    });
  });
}
