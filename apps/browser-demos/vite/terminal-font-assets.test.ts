import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { terminalFontCatalog } from "./terminal-font-assets.mjs";

const require = createRequire(import.meta.url);

test("terminal webfont cmaps cover the published kaomoji and representative scripts", () => {
  const { faces } = require("cool-ascii-faces") as { faces: string[] };
  const { spans } = terminalFontCatalog();
  const codePoints = new Map<number, number>();
  for (let i = 0; i < spans.length; i += 3) {
    for (let cp = spans[i]; cp <= spans[i + 1]; cp++) codePoints.set(cp, spans[i + 2]);
  }
  const scripts = "Olá Tiếng Việt Ελληνικά Українська 日本語 한글 简体中文 繁體中文 ไทย العربية עברית हिन्दी বাংলা ಕನ್ನಡ";
  const missing = [...new Set(faces.join("") + scripts)].filter(char => {
    const cp = char.codePointAt(0)!;
    return cp >= 128 && !codePoints.has(cp);
  });
  assert.equal(faces.length, 271);
  assert.deepEqual(missing, []);

  for (let cp = 0xa0; cp <= 0xff; cp++) {
    // Soft hyphen is a discretionary break and has no visible terminal glyph.
    if (cp !== 0xad) assert.equal(codePoints.get(cp), 0, `base font: U+${cp.toString(16)}`);
  }
});
