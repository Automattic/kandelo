import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "vite";

import {
  HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE,
} from "./lib/homebrew-closed-acceptance";

const root = "/homebrew-main-shell-bottles";
const appRoot = dirname(fileURLToPath(import.meta.url));
const configFile = join(appRoot, "vite.config.ts");

test("Vite builds the private page only beside the real closed product inputs", async () => {
  const savedRoot =
    process.env.VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT;
  const savedInputs = process.env.KANDELO_BROWSER_DEMO_INPUTS;
  try {
    delete process.env.KANDELO_BROWSER_DEMO_INPUTS;
    process.env.VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT = root;
    const closed = await loadConfigFromFile(
      { command: "build", mode: HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE },
      configFile,
      undefined,
      "silent",
    );
    assert.ok(closed);
    assert.deepEqual(
      Object.keys(
        closed.config.build?.rollupOptions?.input as Record<string, string>,
      ).sort(),
      ["homebrew-vfs-test", "main"],
    );

    delete process.env.VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT;
    const ordinary = await loadConfigFromFile(
      { command: "build", mode: "production" },
      configFile,
      undefined,
      "silent",
    );
    assert.ok(ordinary);
    assert.deepEqual(
      Object.keys(
        ordinary.config.build?.rollupOptions?.input as Record<string, string>,
      ).sort(),
      ["kandelo", "main", "network"],
    );

    process.env.VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT = root;
    await assert.rejects(
      loadConfigFromFile(
        { command: "build", mode: "production" },
        configFile,
        undefined,
        "silent",
      ),
      /permitted only in homebrew-closed-acceptance/,
    );
  } finally {
    if (savedRoot === undefined) {
      delete process.env.VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT;
    } else {
      process.env.VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT = savedRoot;
    }
    if (savedInputs === undefined) {
      delete process.env.KANDELO_BROWSER_DEMO_INPUTS;
    } else {
      process.env.KANDELO_BROWSER_DEMO_INPUTS = savedInputs;
    }
  }
});
