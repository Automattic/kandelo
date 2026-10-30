import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { initializeTheme, readThemePreference } from "./theme.ts";

const html = readFileSync(new URL("../../../index.html", import.meta.url), "utf8");
const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(bootstrap, "The app must apply its theme before loading styles");

const preferences = [
  { name: "new visitor", raw: null, family: "kandelo", mode: "dark" },
  { name: "blocked storage", raw: null, blocked: true, family: "kandelo", mode: "dark" },
  { name: "malformed storage", raw: "{", family: "kandelo", mode: "dark" },
  { name: "null storage", raw: "null", family: "kandelo", mode: "dark" },
  { name: "array storage", raw: "[]", family: "kandelo", mode: "dark" },
  { name: "obsolete version", raw: '{"version":3,"family":"ubuntu","mode":"light"}', family: "kandelo", mode: "dark" },
  { name: "invalid family", raw: '{"version":4,"family":"unknown","mode":"light"}', family: "kandelo", mode: "dark" },
  { name: "invalid mode", raw: '{"version":4,"family":"ubuntu","mode":"unknown"}', family: "kandelo", mode: "dark" },
  { name: "saved light", raw: '{"version":4,"family":"kandelo","mode":"light"}', family: "kandelo", mode: "light" },
  { name: "saved dark", raw: '{"version":4,"family":"ubuntu","mode":"dark"}', family: "ubuntu", mode: "dark" },
  { name: "saved auto", raw: '{"version":4,"family":"wordpress","mode":"auto"}', family: "wordpress", mode: "auto" },
  { name: "legacy family", raw: '{"version":1,"family":"balanced","mode":"auto"}', family: "kandelo", mode: "auto" },
  { name: "legacy alias", raw: '{"version":2,"family":"playground","mode":"light"}', family: "wordpress", mode: "light" },
] as const;

for (const systemDark of [false, true]) {
  for (const preference of preferences) {
    test(`${preference.name} agrees before and after app initialization with a ${systemDark ? "dark" : "light"} system`, () => {
      const browser = {
        localStorage: {
          getItem() {
            if ("blocked" in preference && preference.blocked) throw new Error("Storage unavailable");
            return preference.raw;
          },
        },
        matchMedia: () => ({ matches: systemDark }),
      };
      const initialRoot = { dataset: {}, style: {} };
      runInNewContext(bootstrap, { window: browser, document: { documentElement: initialRoot } });
      const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
      const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
      const mountedRoot = { dataset: {}, style: {} };
      try {
        Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
        Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: mountedRoot } });
        assert.deepEqual(readThemePreference(), { family: preference.family, mode: preference.mode });
        initializeTheme();
        const resolved = preference.mode === "auto" ? systemDark ? "dark" : "light" : preference.mode;
        assert.deepEqual(mountedRoot, {
          dataset: { kTheme: preference.family, kMode: resolved, kModePreference: preference.mode },
          style: { colorScheme: resolved },
        });
        assert.deepEqual(initialRoot, mountedRoot);
      } finally {
        if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
        else Reflect.deleteProperty(globalThis, "window");
        if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
        else Reflect.deleteProperty(globalThis, "document");
      }
    });
  }
}
