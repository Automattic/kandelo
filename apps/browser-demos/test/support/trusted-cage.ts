import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, type Page, type TestInfo } from "../../playwright-test";
import { cageFootPromptRows } from "../fixtures/cage-foot-prompt";
import { setInternalsOpen } from "./dock";
import { waitForMachineBootInput } from "./kandelo-machine";
import { typePhysicalText } from "./physical-typing";
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from "./browser-memory-boundary";

interface Pixels { width: number; height: number; data: Uint8Array }
const { PNG } = createRequire(import.meta.url)("playwright-core/lib/utilsBundle") as {
  PNG: { sync: { read(bytes: Buffer): Pixels } };
};
export interface GuestProcess { pid: number; ppid: number; command: string; capacity: string }
const footCommand = /^(?:\/\S*\/)?foot(?:\s|$)/;
const shellCommand = /^(?:-?(?:\/\S*\/)?(?:bash|sh))(?:\s|$)/;
const clientCommand = /\/usr\/libexec\/freeciv\/client\.wasm(?:\s|$)/;
const serverCommand = /\/usr\/libexec\/freeciv\/server\.wasm(?:\s|$)/;
const promptWidth = 180, promptHeight = 28;
const prompt = cageFootPromptRows.flatMap(row => Array.from({ length: promptWidth }, (_, x) =>
  (parseInt(row[x >> 2], 16) & (8 >> (x & 3))) !== 0));
if (prompt.length !== promptWidth * promptHeight || !prompt.some(Boolean)) {
  throw new Error("Invalid Cage prompt reference");
}
function matchesPrompt(pixels: Pixels, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x + promptWidth > pixels.width || y + promptHeight > pixels.height) return false;
  return prompt.every((white, at) => {
    const i = ((y + Math.floor(at / promptWidth)) * pixels.width + x + at % promptWidth) * 4;
    return (Math.min(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]) > 150) === white;
  });
}

/** Drives the normal app UI; it never injects guest input through a kernel API. */
export class CageSession {
  readonly canvas;
  readonly surface;
  readonly errors: string[] = [];
  readonly retirementFailures: string[] = [];
  readonly evidence: Record<string, unknown> = {
    scope: "Bounded factory-image Cage/Foot/Freeciv functionality at 1x density; no sustained or performance claim",
  };
  private cage!: GuestProcess;
  private foot!: GuestProcess;
  private shell!: GuestProcess;

  constructor(readonly page: Page, readonly info: TestInfo) {
    this.canvas = page.locator(".kmachine-primary-slot:not(.is-hidden) .kmodeset-canvas");
    this.surface = page.locator(".kmachine-primary .kmodeset-surface");
    page.on("pageerror", error => this.errors.push(error.stack ?? error.message));
    page.on("console", message => {
      const failedRetirement = /release acknowledgement timed out|retirement wake failed|incomplete graceful generation detach|graceful kernel-worker detach timed out|destroy drain timed out with woken process|force-terminating|terminated the kernel worker realm|kernel-worker realm termination failed/;
      if (message.type() === "error" || failedRetirement.test(message.text())) {
        this.retirementFailures.push(message.text());
      }
    });
  }

  record(fields: Record<string, unknown>) {
    Object.assign(this.evidence, fields, { errors: this.errors, retirementFailures: this.retirementFailures });
    const path = this.info.outputPath("cage.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.evidence, null, 2) + "\n");
  }

  async screenshot(name: string) {
    const path = this.info.outputPath(name + ".png");
    const bytes = await this.page.screenshot({ path, timeout: 10_000 });
    await this.info.attach(name, { path, contentType: "image/png" });
    return bytes;
  }

  async graphics() {
    await setInternalsOpen(this.page, false);
    const button = this.page.getByLabel("Computer views").getByRole("button", { name: "Graphics", exact: true });
    if (await button.getAttribute("aria-current") !== "true") await button.click();
    await this.canvas.focus();
    await expect(this.canvas).toBeFocused();
  }

  async processes(): Promise<GuestProcess[]> {
    await setInternalsOpen(this.page, true);
    await this.page.getByRole("tab", { name: "Procs", exact: true }).click();
    let rows: GuestProcess[] = [];
    await expect.poll(async () => {
      rows = await this.page.locator(".ktable tbody tr").evaluateAll(elements => elements.flatMap(row => {
        const cells = row.querySelectorAll("td");
        return cells.length === 5 ? [{
          pid: Number(cells[0].textContent?.match(/\d+/)?.[0]),
          ppid: Number(cells[1].textContent),
          capacity: cells[3].textContent ?? "",
          command: cells[4].textContent ?? "",
        }] : [];
      }));
      // Loading is an empty table. It must never prove that a process retired.
      return rows.some(process => process.pid === 1);
    }, { timeout: 30_000 }).toBe(true);
    return rows;
  }

  async waitForPrompt() {
    this.record({ stage: "rendered-foot-prompt" });
    await this.graphics();
    await expect.poll(async () => {
      const pixels = PNG.sync.read(await this.page.screenshot());
      const box = await this.surface.boundingBox();
      if (!box || pixels.width !== 1280) throw new Error("Missing unscaled Cage surface");
      for (let y = Math.max(0, Math.floor(box.y)); y < box.y + box.height - promptHeight; y++) {
        for (let x = Math.max(0, Math.floor(box.x) - 1); x <= box.x + 1; x++) {
          if (matchesPrompt(pixels, x, y)) return true;
        }
      }
      return false;
    }, { timeout: 30_000 }).toBe(true);
  }

  async boot() {
    this.record({ stage: "boot" });
    await installBrowserMemoryBoundaryProbe(this.page);
    await this.page.goto("./", { waitUntil: "domcontentloaded" });
    await waitForMachineBootInput(this.page);
    await setInternalsOpen(this.page, true);
    await expect.poll(async () => (await this.page.locator(".ksys-line").allInnerTexts()).join("\n"),
      { timeout: 180_000 }).toMatch(/running .*\/usr\/bin\/cage/);
    let rows: GuestProcess[] = [];
    await expect.poll(async () => {
      rows = await this.processes();
      return rows.filter(process => footCommand.test(process.command)).length;
    }, { timeout: 60_000 }).toBe(1);
    this.foot = rows.find(process => footCommand.test(process.command))!;
    this.cage = rows.find(process => /\/usr\/bin\/cage(?:\s|$)/.test(process.command))!;
    expect(this.cage).toBeDefined();
    await expect.poll(async () => {
      rows = await this.processes();
      this.shell = rows.find(process => process.ppid === this.foot.pid && shellCommand.test(process.command))!;
      return !!this.shell;
    }, { timeout: 30_000 }).toBe(true);
    this.record({ processesBefore: rows });
    await this.graphics();
    await expect.poll(async () => (await this.page.locator(".kdemo-surface-controls").allInnerTexts()).join(" "),
      { timeout: 120_000 }).toMatch(/webgl2-gl/i);
    await this.waitForPrompt();
    await expect(this.surface).toHaveAttribute("data-kms-owner-pid", String(this.cage.pid));
  }

  private async openTmp() {
    await setInternalsOpen(this.page, true);
    await this.page.getByRole("tab", { name: "VFS", exact: true }).click();
    await this.page.locator(".ktable tbody tr").filter({
      has: this.page.locator("td:first-child", { hasText: /^tmp\/$/ }),
    }).first().click();
  }

  private async readTmpFile(name: string) {
    const row = (text: string) => this.page.locator(".ktable tbody tr").filter({
      has: this.page.locator("td:first-child", { hasText: new RegExp("^" + text + "$") }),
    }).first();
    const close = this.page.getByRole("button", { name: "close", exact: true });
    if (await close.isVisible()) await close.click();
    await this.page.getByRole("button", { name: "refresh", exact: true }).click();
    if (!await row(name).isVisible()) return null;
    await row(name).click();
    await expect(this.page.locator("pre")).toBeVisible();
    return this.page.locator("pre").textContent();
  }

  async typeProofAndExitFoot() {
    this.record({ stage: "physical-shell-proof" });
    await typePhysicalText(this.page, "echo cage-group-$$ > /tmp/trusted-cage-proof\n", { delay: 8 });
    await this.openTmp();
    await expect.poll(() => this.readTmpFile("trusted-cage-proof"), { timeout: 30_000 })
      .toBe(`cage-group-${this.shell.pid}\n`);
    this.record({ proofShell: this.shell.pid, stage: "exit-foot" });
    await this.graphics();
    await this.screenshot("typed-foot");
    await this.page.keyboard.press("Control+d");
    await expect(this.surface).toHaveAttribute("data-kms-owner-pid", "0", { timeout: 60_000 });
    let rows: GuestProcess[] = [];
    await expect.poll(async () => {
      rows = await this.processes();
      return rows.filter(process => [this.cage.pid, this.foot.pid, this.shell.pid].includes(process.pid)).length;
    }, { timeout: 60_000 }).toBe(0);
    this.record({ processesAfter: rows });
  }

  private async warmPixels(left: number, top: number, width: number, height: number) {
    const box = (await this.canvas.boundingBox())!;
    const bytes = await this.page.screenshot({ clip: { x: box.x + left, y: box.y + top, width, height } });
    const pixels = PNG.sync.read(bytes);
    let count = 0;
    for (let i = 0; i < pixels.data.length; i += 4) {
      if (pixels.data[i] > 160 && pixels.data[i + 1] > 140 && pixels.data[i + 2] > 110) count++;
    }
    return count;
  }

  private async status() {
    const box = (await this.canvas.boundingBox())!;
    const bytes = await this.page.screenshot({ clip: { x: box.x + box.width / 2 - 200, y: box.y + 3, width: 400, height: 14 } });
    const pixels = PNG.sync.read(bytes);
    let neutralDark = 0;
    for (let i = 0; i < pixels.data.length; i += 4) {
      const rgb = [pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]];
      if (Math.max(...rgb) < 100 && Math.max(...rgb) - Math.min(...rgb) < 20) neutralDark++;
    }
    return { bytes, pixels: Buffer.from(pixels.data), neutralDark };
  }

  private async waitForMenu() {
    await expect.poll(async () => {
      const box = (await this.canvas.boundingBox())!;
      return this.warmPixels(box.width - 200, box.height - 100, 190, 90);
    }, { timeout: 120_000 }).toBeGreaterThan(500);
  }

  private async menuClick(bottom: number) {
    const box = (await this.canvas.boundingBox())!;
    await this.canvas.click({ position: { x: box.width - 100, y: box.height - bottom } });
  }

  async playFreeciv() {
    // Absolute-coordinate mouse checks release real capture, just as the
    // normal Freeciv suite does. Relative captured input is a separate check.
    await this.page.evaluate(() => {
      document.addEventListener("pointerlockchange", () => {
        if (document.pointerLockElement) document.exitPointerLock();
      });
      if (document.pointerLockElement) document.exitPointerLock();
    });
    this.record({ stage: "first-client" });
    await typePhysicalText(this.page, "freeciv > /tmp/trusted-cage-game.log 2>&1\n", { delay: 8 });
    let clients: GuestProcess[] = [];
    await expect.poll(async () => {
      clients = (await this.processes()).filter(process => clientCommand.test(process.command));
      return clients.length;
    }, { timeout: 120_000 }).toBe(1);
    const first = clients[0];
    await this.graphics();
    await this.waitForMenu();
    const intro = await this.status();
    expect(intro.neutralDark).toBeLessThan(2000);
    this.record({ introNegativeControl: intro.neutralDark, firstClient: first });
    await this.screenshot("freeciv-menu");
    await this.menuClick(32);
    this.record({ stage: "quit-first-client" });
    let rows: GuestProcess[] = [];
    await expect.poll(async () => {
      rows = await this.processes();
      return rows.some(process => process.pid === first.pid);
    }, { timeout: 60_000 }).toBe(false);
    expect(rows.some(process => process.pid === this.shell.pid)).toBe(true);
    this.record({ afterFirstQuit: rows });
    await this.waitForPrompt();
    await this.screenshot("returned-foot");

    // Relaunch in the same machine after the ZIP's game assets have loaded.
    this.record({ stage: "second-client" });
    await typePhysicalText(this.page, "freeciv > /tmp/trusted-cage-second.log 2>&1\n", { delay: 8 });
    await expect.poll(async () => {
      clients = (await this.processes()).filter(process => clientCommand.test(process.command));
      return clients.length;
    }, { timeout: 60_000 }).toBe(1);
    expect(clients[0].pid).not.toBe(first.pid);
    const second = clients[0];
    await this.graphics();
    await this.waitForMenu();
    await this.menuClick(170);
    this.record({ stage: "local-server", secondClient: second });
    await expect.poll(async () => {
      rows = await this.processes();
      return rows.filter(process => serverCommand.test(process.command) && process.ppid === second.pid).length;
    }, { timeout: 90_000 }).toBe(1);
    this.record({ processesWithServer: rows });
    await this.graphics();
    await expect.poll(async () => {
      const box = (await this.canvas.boundingBox())!;
      return this.warmPixels(20, box.height - 110, 300, 50);
    }, { timeout: 90_000 }).toBeGreaterThan(500);
    await this.screenshot("freeciv-lobby");
    const box = (await this.canvas.boundingBox())!;
    await this.canvas.click({ position: { x: box.width - 50, y: box.height - 24 } });
    this.record({ stage: "game-world" });
    await expect.poll(async () => (await this.status()).neutralDark, { timeout: 90_000 }).toBeGreaterThan(2000);
    await this.screenshot("freeciv-world");
    await expect(this.surface).toHaveAttribute("data-kms-owner-pid", String(this.cage.pid));

    // The intro's dark red band fails this oracle. Require a stable in-game
    // status before the real end-turn key, so cursor/frame churn cannot pass.
    let before = await this.status(), stable = 0;
    await expect.poll(async () => {
      const next = await this.status();
      stable = before.pixels.equals(next.pixels) ? stable + 1 : 0;
      before = next;
      return stable;
    }, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
    writeFileSync(this.info.outputPath("status-before.png"), before.bytes);
    this.record({ stage: "end-turn", stableStatusCaptures: stable });
    await this.canvas.focus();
    await this.page.keyboard.press("Shift+Enter", { delay: 100 });
    await expect.poll(async () => before.pixels.equals((await this.status()).pixels),
      { timeout: 60_000 }).toBe(false);
    await this.screenshot("freeciv-next-turn");
  }

  async assertQuiet() {
    const boundary = await memoryBoundaryFailures(this.page);
    this.record({ boundary });
    expect(boundary).toEqual([]);
    expect(this.errors).toEqual([]);
    expect(this.retirementFailures).toEqual([]);
  }

  async quitGame() {
    this.record({ stage: "quit-running-game" });
    const before = await this.processes();
    const owned = before.filter(process => clientCommand.test(process.command) || serverCommand.test(process.command));
    expect(owned.filter(process => clientCommand.test(process.command))).toHaveLength(1);
    expect(owned.filter(process => serverCommand.test(process.command))).toHaveLength(1);
    await this.graphics();
    const box = (await this.canvas.boundingBox())!;
    const clip = { x: box.x + box.width / 2 - 150, y: box.y + box.height / 2 - 150, width: 300, height: 300 };
    const beforeOptions = PNG.sync.read(await this.page.screenshot({ clip })).data;
    // Escape first cancels an active map command. Use the native Options
    // button and observe its dialog before activating the dialog's Quit key.
    await this.canvas.click({ position: { x: 16, y: 16 } });
    await expect.poll(async () => {
      const after = PNG.sync.read(await this.page.screenshot({ clip })).data;
      let changed = 0;
      for (let i = 0; i < after.length; i += 4) {
        if (Math.abs(after[i] - beforeOptions[i]) + Math.abs(after[i + 1] - beforeOptions[i + 1])
            + Math.abs(after[i + 2] - beforeOptions[i + 2]) > 90) changed++;
      }
      return changed;
    }, { timeout: 30_000 }).toBeGreaterThan(5000);
    await this.screenshot("freeciv-options");
    await this.page.keyboard.press("q", { delay: 100 });
    let rows: GuestProcess[] = [];
    await expect.poll(async () => {
      rows = await this.processes();
      this.record({ processesDuringQuit: rows });
      return rows.filter(process => owned.some(previous => previous.pid === process.pid)).length;
    }, { timeout: 90_000 }).toBe(0);
    expect(rows.some(process => process.pid === this.foot.pid)).toBe(true);
    expect(rows.some(process => process.pid === this.shell.pid)).toBe(true);
    this.record({ afterGameQuit: rows });
    await this.waitForPrompt();
    await this.screenshot("foot-after-game");
  }
}
