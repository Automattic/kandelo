import { expect, test, type Page } from "@playwright/test";
import { gotoMachine } from "./support/kandelo-machine";
import { footFrame, type Rect } from "./support/labwc-frame";
import { typePhysicalText } from "./support/physical-typing";
import { runTerminalCommand } from "./support/terminal-command";

// Every normal runner project exercises its real renderer without taking
// desktop focus. Worker-scoped headless belongs at file scope.
test.use({ headless: true, deviceScaleFactor: 1, viewport: { width: 1440, height: 1000 } });

const scene = (page: Page) => page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();
const owner = async (page: Page) => Number(await page.locator(".kmachine-primary .kmodeset-surface")
  .getAttribute("data-kms-owner-pid"));

async function releasePointer(page: Page) {
  if (await page.evaluate(() => document.pointerLockElement !== null)) {
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);
  }
}

async function surface(page: Page, label: "Demo" | "Internals") {
  await releasePointer(page);
  const internals = page.getByRole("button", { name: "Internals", exact: true });
  await expect(internals).toBeEnabled({ timeout: 180_000 });
  if (((await internals.getAttribute("aria-pressed")) === "true") !== (label === "Internals"))
    await internals.click();
  if (label === "Demo") {
    const demo = page.getByLabel("Computer views").getByRole("button", { name: "Demo", exact: true });
    if ((await demo.getAttribute("aria-current")) !== "true") await demo.click();
    await expect(scene(page)).toBeVisible();
  }
}

async function processes(page: Page, footCount: number) {
  await surface(page, "Internals");
  await page.getByRole("tab", { name: "Procs", exact: true }).click();
  const commands = page.locator(".ktable tbody tr > td:last-child");
  await expect(commands.filter({ hasText: /^(?:\/\S*\/)?foot(?:\s|$)/ }))
    .toHaveCount(footCount, { timeout: 90_000 });
  await expect(commands.filter({ hasText: /^(?:\/\S*\/)?sfwbar(?:\s|$)/ }))
    .toHaveCount(1, { timeout: 90_000 });
  await surface(page, "Demo");
}

/** Read actual guest command results through the shipped VFS inspector.
 * This uses its kernel-owned readFile path, not a main-realm filesystem.
 */
async function readTmp(page: Page, name: string) {
  await surface(page, "Internals");
  await page.getByRole("tab", { name: "VFS", exact: true }).click();
  await page.getByRole("button", { name: "/", exact: true }).click();
  const row = (name: string) => page.locator(".ktable tbody tr").filter({
    has: page.locator("td:first-child", { hasText: new RegExp(`^${name}$`) }),
  }).first();
  await row("tmp/").click();
  await expect.poll(async () => {
    await page.getByRole("button", { name: "refresh", exact: true }).click();
    return row(name).count();
  }, { timeout: 60_000 }).toBe(1);
  await row(name).click();
  const preview = page.locator("pre").filter({ hasText: "DATA_DIRS=" });
  await expect(preview).toBeVisible({ timeout: 60_000 });
  return preview.innerText();
}

type PaintedRect = Rect & { pixels: number; textRows: number };
type Paint = {
  width: number; height: number; start: PaintedRect | null;
  menus: PaintedRect[]; highlights: PaintedRect[]; tasks: Rect[];
  red: number; blue: number; green: number; purple: number;
};

/** Inspect screenshots of the real KMS renderer. The palette is the shipped
 * sfwbar.config: #40516b Start/hover, #323232 panel/menu, #eeeeee label text.
 * Connected filled rectangles and separate glyph rows exclude a cursor or
 * terminal output from satisfying panel/menu readiness.
 */
async function paint(page: Page): Promise<Paint> {
  const png = await scene(page).screenshot({ animations: "disabled" });
  return page.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const { width, height, data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    const blue = new Uint8Array(width * height), gray = new Uint8Array(width * height);
    const ink = new Uint8Array(width * height);
    let red = 0, terminalBlue = 0, green = 0, purple = 0;
    for (let i = 0; i < blue.length; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      blue[i] = Math.abs(r - 64) <= 2 && Math.abs(g - 81) <= 2 && Math.abs(b - 107) <= 2 ? 1 : 0;
      gray[i] = Math.abs(r - 50) <= 1 && Math.abs(g - 50) <= 1 && Math.abs(b - 50) <= 1 ? 1 : 0;
      ink[i] = r > 180 && g > 180 && b > 180 ? 1 : 0;
      if (r > 210 && g < 45 && b < 45) red++;
      if (r < 45 && g < 70 && b > 210) terminalBlue++;
      if (r >= 20 && r <= 45 && g >= 170 && g <= 195 && b >= 50 && b <= 75) green++;
      if (r >= 170 && r <= 195 && g >= 20 && g <= 45 && b >= 170 && b <= 195) purple++;
    }
    function runs(values: boolean[], gap: number) {
      const result: [number, number][] = [];
      let start = -1, last = -1;
      for (let i = 0; i <= values.length + gap; i++) {
        if (values[i]) { if (start < 0) start = i; last = i; }
        else if (start >= 0 && i - last > gap) { result.push([start, last]); start = -1; }
      }
      return result;
    }
    function components(original: Uint8Array): PaintedRect[] {
      const mask = original.slice(), queue = new Int32Array(mask.length), result: PaintedRect[] = [];
      for (let seed = 0; seed < mask.length; seed++) {
        if (!mask[seed]) continue;
        let head = 0, tail = 1, left = width, top = height, right = 0, bottom = 0;
        queue[0] = seed; mask[seed] = 0;
        while (head < tail) {
          const p = queue[head++], x = p % width, y = Math.floor(p / width);
          left = Math.min(left, x); right = Math.max(right, x);
          top = Math.min(top, y); bottom = Math.max(bottom, y);
          const visit = (n: number) => { if (mask[n]) { mask[n] = 0; queue[tail++] = n; } };
          if (x) visit(p - 1); if (x + 1 < width) visit(p + 1);
          if (y) visit(p - width); if (y + 1 < height) visit(p + width);
        }
        const w = right - left + 1, h = bottom - top + 1;
        if (w < 35 || h < 14 || tail < w * h * 0.6) continue;
        const rows: boolean[] = [];
        for (let y = top; y <= bottom; y++) {
          let count = 0;
          for (let x = left; x <= right; x++) count += ink[y * width + x];
          rows.push(count >= 8);
        }
        result.push({ x: left, y: top, width: w, height: h, pixels: tail,
          textRows: runs(rows, 3).filter(([a, b]) => b - a >= 5).length });
      }
      return result;
    }
    const colored = components(blue);
    const start = colored.find(r => r.x < 80 && r.y > height - 90 && r.width >= 45
      && r.width < 150 && r.height >= 25 && r.height < 75 && r.textRows === 1) ?? null;
    const menuMask = new Uint8Array(width * height);
    if (start) for (let p = 0; p < menuMask.length; p++)
      if (Math.floor(p / width) < start.y - 1) menuMask[p] = gray[p] || blue[p];
    const menus = components(menuMask).filter(r => r.width >= 80 && r.width < 450
      && r.height >= 24 && r.height < 350 && r.textRows > 0);
    const highlights = colored.filter(r => start && r.y + r.height < start.y
      && r.width >= 80 && r.width < 450 && r.height < 65 && r.textRows === 1);
    const tasks: Rect[] = [];
    if (start) {
      const cols: boolean[] = [];
      const begin = start.x + start.width + 4, end = width - 120;
      for (let x = begin; x < end; x++) {
        let n = 0;
        for (let y = start.y + 4; y < start.y + start.height - 4; y++) n += ink[y * width + x];
        cols.push(n >= 2 && n < start.height * 0.8);
      }
      for (const [a, b] of runs(cols, 8)) if (b - a >= 20)
        tasks.push({ x: begin + a, y: start.y, width: b - a + 1, height: start.height });
    }
    return { width, height, start, menus, highlights, tasks, red, blue: terminalBlue, green, purple };
  }, png.toString("base64"));
}

async function clickRect(page: Page, frame: Paint, rect: Rect, button: "left" | "right" = "left") {
  const box = (await scene(page).boundingBox())!;
  // With pointer lock, Playwright's next motion supplies the displacement
  // from our previous click. There are no intervening dock/mouse actions
  // between opening a popup and clicking its selected entry.
  await page.mouse.move(box.x + (rect.x + rect.width / 2) * box.width / frame.width,
    box.y + (rect.y + rect.height / 2) * box.height / frame.height);
  await page.mouse.down({ button }); await page.mouse.up({ button });
}

async function screenshot(page: Page, name: string, frame: Paint) {
  await test.info().attach(name, { body: await scene(page).screenshot(), contentType: "image/png" });
  await test.info().attach(`${name}-geometry`, { body: JSON.stringify(frame), contentType: "application/json" });
}

for (const compositor of ["sway", "labwc"] as const) {
  test(`${compositor}: SFWBar native Start launches Terminal, focuses and closes clients, and exits with its compositor`, async ({ page }) => {
    test.setTimeout(600_000);
    await gotoMachine(page, compositor);
    await surface(page, "Demo");
    await expect.poll(async () => (await page.locator(".kdemo-surface-controls").allInnerTexts()).join(" "),
      { timeout: 180_000 }).toMatch(/webgl2-gl/i);
    await expect.poll(() => owner(page), { timeout: 180_000 }).toBeGreaterThan(0);
    const compositorOwner = await owner(page);
    await expect.poll(async () => (await paint(page)).start !== null,
      { timeout: 180_000, intervals: [1_000] }).toBe(true);
    await expect.poll(async () => (await footFrame(page)).foot !== null, { timeout: 180_000 }).toBe(true);

    const first = await footFrame(page), bounds = first.foot!;
    const box = (await scene(page).boundingBox())!;
    await scene(page).click({ position: { x: (bounds.x + 30) * box.width / first.width,
      y: (bounds.y + 30) * box.height / first.height } });
    await typePhysicalText(page, "PS1=; mark=first; printf '\\033]0;FIRST\\007\\033[48;2;220;30;30mFIRST_READY\\033[0m\\n'\n", { delay: 20 });
    await expect.poll(async () => (await paint(page)).red, { timeout: 60_000 }).toBeGreaterThan(200);

    // Guard the actual default desktop search path and entry inventory before
    // selecting the last sorted category. No test-only XDG or menu overrides.
    await typePhysicalText(page, "{ printf 'DATA_HOME=%s\\nDATA_DIRS=%s\\n' \"${XDG_DATA_HOME-}\" \"${XDG_DATA_DIRS-}\"; "
      + "for d in \"${XDG_DATA_HOME:-$HOME/.local/share}/applications\" /usr/local/share/applications /usr/share/applications; "
      + "do for f in \"$d\"/*.desktop; do if test -f \"$f\"; then printf 'FILE:%s\\n' \"$f\"; cat \"$f\"; fi; done; done; "
      + "} > /tmp/sfwbar-inventory\n", { delay: 15 });
    const inventory = await readTmp(page, "sfwbar-inventory");
    expect(inventory).toMatch(/^DATA_HOME=\nDATA_DIRS=\n/);
    expect([...inventory.matchAll(/^FILE:(.+)$/gm)].map(m => m[1]).sort()).toEqual([
      "/usr/share/applications/kandelo-terminal.desktop", "/usr/share/applications/scummvm.desktop",
      "/usr/share/applications/wayland-demo.desktop",
    ]);
    expect(inventory).toContain("Name=Terminal\n");
    expect(inventory).toContain("Categories=System;TerminalEmulator;");
    expect(inventory).toContain("Categories=Game;");
    expect(inventory).toContain("Categories=Graphics;");
    await processes(page, 1);

    const panel = await paint(page);
    expect(panel.start).not.toBeNull();
    await screenshot(page, `${compositor}-sfwbar-panel`, panel);
    await clickRect(page, panel, panel.start!);
    await expect.poll(async () => (await paint(page)).menus.some(r => r.textRows === 3),
      { timeout: 60_000, intervals: [500, 1_000] }).toBe(true);
    const categories = (await paint(page)).menus.find(r => r.textRows === 3)!;
    await screenshot(page, `${compositor}-sfwbar-native-appmenu`, await paint(page));

    // Upstream appmenu's sorted category labels are Games, Graphics and
    // System Tools for the guarded three entries. GTK End/Right selects
    // System Tools and opens its genuine one-entry Terminal submenu.
    await page.keyboard.press("End"); await page.keyboard.press("ArrowRight");
    const terminalMenu = (p: Paint) => p.menus.find(r => r.textRows === 1
      && r.x >= categories.x + categories.width - 10 && r.height < categories.height * 0.65);
    await expect.poll(async () => terminalMenu(await paint(page)) !== undefined, { timeout: 30_000 }).toBe(true);
    const submenu = await paint(page);
    await screenshot(page, `${compositor}-sfwbar-terminal-entry`, submenu);
    await clickRect(page, submenu, terminalMenu(submenu)!);
    // The real GTK menu action execs the shipped terminal launcher. A Start
    // repaint or process spawn alone cannot satisfy the rendered shell proof.
    await expect.poll(async () => (await paint(page)).menus.length, { timeout: 30_000 }).toBe(0);
    // Wait for two actual mapped title labels before Escape or dock input:
    // otherwise Escape can reach the still-open application menu and cancel
    // the launch. The bar-only glyph classifier excludes Start and clock;
    // its 20px minimum accepts both FIRST and foot's initial "foot" title.
    await expect.poll(async () => (await paint(page)).tasks.length, { timeout: 60_000 }).toBe(2);
    await processes(page, 2);
    // Inspecting processes moved browser focus to the dock. Restore only DOM
    // keyboard focus, preserving the compositor's newly activated client.
    await scene(page).focus();
    await typePhysicalText(page, "PS1=; mark=second; printf '\\033]0;SECOND\\007\\033[48;2;30;50;220mSECOND_READY\\033[0m\\n'\n", { delay: 20 });
    await expect.poll(async () => (await paint(page)).blue, { timeout: 90_000 }).toBeGreaterThan(200);
    await expect.poll(async () => (await paint(page)).tasks.length, { timeout: 60_000 }).toBe(2);

    // Click actual title glyph runs rather than assumed taskbar cell widths.
    // The two saved shell variables must differ: a focus repaint, key echo,
    // or writing twice to the same PTY cannot pass the final file assertions.
    let tasks = await paint(page);
    await clickRect(page, tasks, tasks.tasks[0]);
    await typePhysicalText(page, "printf 'LEFT:%s\\n' \"$mark\" > /tmp/sfwbar-left; "
      + "printf '\\033[48;2;30;180;60mFOCUSED_LEFT\\033[0m\\n'\n", { delay: 20 });
    await expect.poll(async () => (await paint(page)).green, { timeout: 60_000 }).toBeGreaterThan(200);
    await releasePointer(page);
    tasks = await paint(page);
    expect(tasks.tasks).toHaveLength(2);
    await clickRect(page, tasks, tasks.tasks[1]);
    await typePhysicalText(page, "printf 'RIGHT:%s\\n' \"$mark\" > /tmp/sfwbar-right; "
      + "printf '\\033[48;2;180;30;180mFOCUSED_RIGHT\\033[0m\\n'\n", { delay: 20 });
    await expect.poll(async () => (await paint(page)).purple, { timeout: 60_000 }).toBeGreaterThan(200);
    await screenshot(page, `${compositor}-sfwbar-two-task-focus`, await paint(page));
    expect(await owner(page)).toBe(compositorOwner);

    // Right-click this real task. The shipped winops menu has Focus, Close,
    // Minimize and Maximize; select its second actual painted row and click.
    await releasePointer(page);
    tasks = await paint(page);
    await clickRect(page, tasks, tasks.tasks[1], "right");
    await expect.poll(async () => (await paint(page)).menus.some(r => r.textRows === 4),
      { timeout: 30_000 }).toBe(true);
    await page.keyboard.press("Home"); await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await paint(page)).highlights.length, { timeout: 30_000 }).toBe(1);
    const close = await paint(page);
    await screenshot(page, `${compositor}-sfwbar-close-action`, close);
    await clickRect(page, close, close.highlights[0]);
    await processes(page, 1);
    await expect.poll(async () => (await paint(page)).tasks.length, { timeout: 60_000 }).toBe(1);
    expect(await owner(page)).toBe(compositorOwner);

    // Restore browser and guest focus through the actual task, then invoke
    // the compositor's normal cooperative exit client from that foot shell.
    // No host kill, test exit wrapper or forced click. Sway's CtrlShiftE
    // opens a separate swaynag confirmation, covered by kandelo-sway.spec.
    const remaining = await paint(page);
    await clickRect(page, remaining, remaining.tasks[0]);
    await typePhysicalText(page, `${compositor === "sway" ? "swaymsg exit" : "labwc --exit"}\n`, { delay: 20 });
    await expect.poll(() => owner(page), { timeout: 90_000 }).toBe(0);
    await expect(page.getByLabel("Computer views").getByRole("button", { name: "Terminal", exact: true }))
      .toHaveAttribute("aria-current", "true", { timeout: 60_000 });
    await releasePointer(page);
    await page.locator(".kshell-terminal-slot:not([hidden]) .xterm-screen").click();
    await typePhysicalText(page, "printf 'COMPOSITOR_STATUS:%s\\n' \"$?\"\n", { delay: 20 });
    await expect.poll(() => page.locator(".kshell-terminal-slot:not([hidden]) .xterm-rows").innerText(),
      { timeout: 30_000 }).toContain("COMPOSITOR_STATUS:0");
    const focus = await runTerminalCommand(page, "cat /tmp/sfwbar-left /tmp/sfwbar-right");
    const marks = [...focus.output.matchAll(/(?:LEFT|RIGHT):(first|second)/g)].map(m => m[1]);
    expect(marks.sort(), "taskbar Focus delivered input to two distinct foot shells").toEqual(["first", "second"]);
    await expect.poll(async () => (await runTerminalCommand(page, "ps -A -o pid,comm")).output,
      { timeout: 90_000, intervals: [500, 1_000] }).not.toMatch(/(?:^|\s)(?:\/\S*\/)?(?:sfwbar|foot|sway|swaybar|swaybg|labwc)(?:\s|$)/m);
    expect(await owner(page)).toBe(0);
  });
}
