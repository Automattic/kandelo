import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { contrast } from "./theme-contrast";

const styles = ["tokens.css", "styles.css"].map((file) =>
  readFileSync(new URL(`../pages/kandelo/${file}`, import.meta.url), "utf8")
).join("\n");

// Exercise the production CSS without booting a guest: theme contrast is an
// app contract, independent of which program supplies the framebuffer.
const controls = `
  <section style="background:var(--kdock-bg)">
    <button data-contrast="dock" class="kdock-item">Theme</button>
    <button data-contrast="current dock" class="kdock-item" aria-current="true">Demo</button>
    <button data-contrast="pressed dock" class="kdock-item" aria-pressed="true">Internals</button>
    <button data-contrast="dock header" class="kdock-header-btn" aria-pressed="true">×</button>
    <button data-contrast="dock tab" class="kdock-view-tab" aria-selected="true">Terminal</button>
    <span data-contrast="running" class="kdock-status-text" data-status="running">Running</span>
    <span data-contrast="booting" class="kdock-status-text" data-status="booting">Booting</span>
  </section>
  <section class="kdemo-surface-controls">
    <button data-contrast="display action" class="kdemo-surface-action">Play a freeware game</button>
    <span data-contrast="active display badge" class="kdemo-surface-badge" data-active="true">2 flips</span>
  </section>
  <section class="kdemo-dock-menu-list" style="position:static">
    <div data-contrast="menu heading" class="kdemo-dock-menu-group">Games</div>
    <button class="kdemo-dock-menu-item">
      <span data-contrast="menu label">Beneath a Steel Sky</span>
      <span data-contrast="menu detail" class="kdemo-dock-menu-detail">69 MB</span>
    </button>
  </section>
  <section style="background:var(--k-surface-sunk)">
    <button data-contrast="theme mode" class="ktheme-mode-button" aria-pressed="true">Auto</button>
    <button data-contrast="resolved theme mode" class="ktheme-mode-button" data-auto-resolved="true">Light</button>
    <button data-contrast="new tab" class="knew-tab" aria-selected="true">Presets</button>
    <span data-contrast="URL accent" class="kurl-hash">#k1=example</span>
  </section>
  <section class="kinternals-tabs">
    <button data-contrast="internals tab" class="kinternals-tab" aria-selected="true">Syslog</button>
  </section>
  <section style="background:var(--k-surface)">
    <button data-contrast="new primary" class="knew-primary">Boot</button>
    <button data-contrast="URL primary" class="kurl-btn kurl-btn-primary">Boot</button>
    <button data-contrast="demo primary" class="kdemo-run">Run</button>
    <button data-contrast="gallery primary" class="kgal-row-btn kgal-row-btn-primary">Launch</button>
    <button data-contrast="share primary" class="kshare-btn kshare-btn-primary">Copy link</button>
    <button data-contrast="empty primary" class="kempty-btn">Inspect and boot</button>
    <span data-contrast="current machine" class="kgal-current-badge">Current</span>
    <button data-contrast="audio enable" class="kpcm-audio-enable">Enable audio</button>
    <button data-contrast="new link" class="knew-link">Browse all</button>
    <button data-contrast="gallery description" class="kgal-description-toggle">Read more</button>
    <span data-contrast="share auto" class="kshare-mode-auto">Auto</span>
    <span data-contrast="URL running" class="kurl-state">Running</span>
    <span data-contrast="URL booting" class="kurl-state" data-status="booting">Booting</span>
    <span data-contrast="URL mode" class="kurl-mode">Live</span>
    <button data-contrast="machine view" class="kmachine-switch-btn" aria-current="true">Demo</button>
    <button data-contrast="sidebar" class="ksb-item" aria-current="true">Gallery</button>
    <span data-contrast="syslog info" class="ksys-lvl ksys-lvl-info">Info</span>
    <span data-contrast="syslog warning" class="ksys-lvl ksys-lvl-warn">Warning</span>
    <span data-contrast="syslog error" class="ksys-lvl ksys-lvl-err">Error</span>
    <span data-contrast="syslog success" class="ksys-lvl ksys-lvl-ok">Success</span>
    <button data-contrast="copied URL" class="kgal-copy-url-btn is-copied">Copied</button>
    <button data-contrast="copy URL error" class="kgal-copy-url-btn is-error">Failed</button>
  </section>`;

const textRoles = [
  "k-text", "k-text-muted", "k-text-faint", "k-accent-ink", "k-ok-ink",
  "k-warn-ink", "k-err-ink", "k-info-ink", "kdock-text", "kdock-muted", "kdock-faint",
];
const surfaces = [
  "k-bg", "k-surface", "k-surface-alt", "k-surface-sunk",
  "kdock-bg", "kdock-bg-raised", "kdock-bg-sunk", "k-fb-bg",
];
const palette = surfaces.map((surface) => `<section style="background:var(--${surface})">${
  textRoles.map((role) => `<span data-contrast="${role} on ${surface}" style="color:var(--${role})">Text</span>`).join("")
}</section>`).join("");
const overlays = ["black", "white"].map((color) => `<section style="background:${color}">
  <button data-contrast="touch control over ${color}" class="ktouch-btn">Fire</button>
  <div data-contrast="drop prompt over ${color}" class="kexchange-dropzone" data-refused="false" style="position:static">Drop to send to this machine</div>
  <div data-contrast="refused drop prompt over ${color}" class="kexchange-dropzone" data-refused="true" style="position:static">This machine doesn't accept files</div>
  <div class="kmodeset-waiting" style="position:static">
    <span data-contrast="waiting over ${color}">Waiting for display</span>
    <span data-contrast="waiting detail over ${color}" class="kmodeset-waiting-secondary">Run a program</span>
  </div>
</section>`).join("");

for (const family of ["wordpress", "kandelo", "ubuntu"]) {
  for (const mode of ["light", "dark"]) {
    test(`${family} ${mode}: shared UI text contrasts with its surface`, async ({ page }) => {
      await page.setContent(`<style>${styles}
        section { margin:12px; padding:12px; display:flex; flex-wrap:wrap; gap:8px; }
        *, *::before, *::after { transition:none !important; animation:none !important; }
      </style>${controls}${palette}${overlays}`);
      await page.evaluate(({ family, mode }) => {
        document.documentElement.dataset.kTheme = family;
        document.documentElement.dataset.kMode = mode;
      }, { family, mode });
      // Guard new CSS consumers too: decorative hues are not text colors,
      // and text for a solid selected fill must never go on a surface/tint.
      const wrongRoles = await page.evaluate(() => {
        const failures: string[] = [];
        const visit = (rules: CSSRuleList) => {
          for (const rule of rules) {
            if (rule instanceof CSSStyleRule) {
              if (/var\(--k-(?:accent(?:-fire|-ember)?|ok|warn|err|info)\)/.test(rule.style.color)) {
                failures.push(`${rule.selectorText}: decorative color used as text`);
              }
              if (rule.style.color.includes("var(--kdock-active-text)") &&
                  rule.style.background !== "var(--kdock-active-fill)") {
                failures.push(`${rule.selectorText}: selected text without its solid fill`);
              }
            }
            if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
          }
        };
        for (const sheet of document.styleSheets) visit(sheet.cssRules);
        return failures;
      });
      expect(wrongRoles).toEqual([]);
      const check = async (state: string, names?: Array<string | null>) => {
        for (const result of await contrast(page)) {
          if (names && !names.includes(result.name)) continue;
          expect.soft(result.ratio, `${result.name}, ${state}`).toBeGreaterThanOrEqual(4.5);
        }
      };
      await check("normal");
      // Descendants such as the menu detail must follow the hovered/focused
      // control's actual background, not a separately tested palette swatch.
      for (const control of await page.locator("button").all()) {
        const names = await control.evaluate((node) => [node, ...node.querySelectorAll("[data-contrast]")]
          .map((n) => n.getAttribute("data-contrast")));
        await control.hover();
        await check(`hover ${await control.textContent()}`, names);
        await page.mouse.down();
        try {
          await check(`pressed ${await control.textContent()}`, names);
        } finally {
          await page.mouse.up();
        }
        await page.mouse.move(0, 0);
        await control.focus();
        await check(`focus ${await control.textContent()}`, names);
        await control.blur();
      }
    });
  }
}
