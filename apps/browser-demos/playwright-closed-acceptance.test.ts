import assert from "node:assert/strict";
import test from "node:test";

import {
  HOMEBREW_CLOSED_ACCEPTANCE_PLAYWRIGHT_ROOT_ENV,
  HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE,
  HOMEBREW_CLOSED_ACCEPTANCE_VITE_ROOT_ENV,
} from "./lib/homebrew-closed-acceptance";
import {
  PLAYWRIGHT_VITE_NO_HMR_ENV,
  playwrightWebServerEnvironment,
} from "./playwright-closed-acceptance";

const root = "/homebrew-main-shell-bottles";

test("scopes closed mirror authority to the managed Vite server", () => {
  const parent = {
    PATH: "/declared/bin",
    OMITTED: undefined,
    [HOMEBREW_CLOSED_ACCEPTANCE_PLAYWRIGHT_ROOT_ENV]: ` ${root} `,
  };
  const original = { ...parent };

  const child = playwrightWebServerEnvironment(
    HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE,
    parent,
  );

  assert.deepEqual(parent, original);
  assert.deepEqual(child, {
    PATH: "/declared/bin",
    [PLAYWRIGHT_VITE_NO_HMR_ENV]: "1",
    [HOMEBREW_CLOSED_ACCEPTANCE_VITE_ROOT_ENV]: root,
  });
});

test("ordinary Playwright servers receive no closed mirror authority", () => {
  assert.deepEqual(
    playwrightWebServerEnvironment("development", {
      PATH: "/declared/bin",
      OMITTED: undefined,
    }),
    {
      PATH: "/declared/bin",
      [PLAYWRIGHT_VITE_NO_HMR_ENV]: "1",
    },
  );
  assert.throws(
    () =>
      playwrightWebServerEnvironment("production", {
        [HOMEBREW_CLOSED_ACCEPTANCE_PLAYWRIGHT_ROOT_ENV]: root,
      }),
    /permitted only in homebrew-closed-acceptance/,
  );
});

test("keeps Playwright pages stable when the parent enables Vite HMR", () => {
  const parent = {
    PATH: "/declared/bin",
    [PLAYWRIGHT_VITE_NO_HMR_ENV]: "0",
  };

  assert.deepEqual(
    playwrightWebServerEnvironment("development", parent),
    {
      PATH: "/declared/bin",
      [PLAYWRIGHT_VITE_NO_HMR_ENV]: "1",
    },
  );
  assert.equal(parent[PLAYWRIGHT_VITE_NO_HMR_ENV], "0");
});

test("rejects Vite authority leaked into the Playwright parent", () => {
  assert.throws(
    () =>
      playwrightWebServerEnvironment(
        HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE,
        {
          [HOMEBREW_CLOSED_ACCEPTANCE_PLAYWRIGHT_ROOT_ENV]: root,
          [HOMEBREW_CLOSED_ACCEPTANCE_VITE_ROOT_ENV]: root,
        },
      ),
    /must be scoped to Playwright's managed Vite server/,
  );
});
