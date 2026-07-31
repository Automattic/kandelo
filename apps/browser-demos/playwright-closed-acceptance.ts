import {
  HOMEBREW_CLOSED_ACCEPTANCE_PLAYWRIGHT_ROOT_ENV,
  HOMEBREW_CLOSED_ACCEPTANCE_VITE_ROOT_ENV,
  homebrewClosedAcceptancePlaywrightRoot,
} from "./lib/homebrew-closed-acceptance";

type Environment = Readonly<Record<string, string | undefined>>;

export const PLAYWRIGHT_VITE_NO_HMR_ENV = "KANDELO_BROWSER_TEST_NO_HMR";

/**
 * Build the environment for Playwright's managed Vite server.
 *
 * Closed-mirror authority stays confined to that child, and browser tests run
 * without Vite hot reloads so test-owned fixture writes cannot navigate an
 * unrelated page while it is making assertions.
 */
export function playwrightWebServerEnvironment(
  viteMode: string,
  parentEnvironment: Environment,
): Record<string, string> {
  if (
    parentEnvironment[HOMEBREW_CLOSED_ACCEPTANCE_VITE_ROOT_ENV] !== undefined
  ) {
    throw new Error(
      `${HOMEBREW_CLOSED_ACCEPTANCE_VITE_ROOT_ENV} must be scoped to ` +
        "Playwright's managed Vite server",
    );
  }
  const root = homebrewClosedAcceptancePlaywrightRoot(
    viteMode,
    parentEnvironment[HOMEBREW_CLOSED_ACCEPTANCE_PLAYWRIGHT_ROOT_ENV],
  );
  const childEnvironment: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnvironment)) {
    if (
      value !== undefined &&
      key !== HOMEBREW_CLOSED_ACCEPTANCE_PLAYWRIGHT_ROOT_ENV &&
      key !== HOMEBREW_CLOSED_ACCEPTANCE_VITE_ROOT_ENV &&
      key !== PLAYWRIGHT_VITE_NO_HMR_ENV
    ) {
      childEnvironment[key] = value;
    }
  }
  if (root !== undefined) {
    // WHY: VITE_* values are compile-time authority. Keep this one out of the
    // Playwright parent/test workers so their ordinary child Vite servers
    // cannot accidentally admit the private acceptance fixture.
    childEnvironment[HOMEBREW_CLOSED_ACCEPTANCE_VITE_ROOT_ENV] = root;
  }
  // WHY: Playwright cases intentionally create and remove test-only modules
  // under the repository. HMR treats those writes as product edits and can
  // reload the next test midway through navigation, turning healthy module
  // requests into ERR_ABORTED failures. Automated tests need a stable page;
  // interactive `vite` sessions retain their normal hot-reload behavior.
  childEnvironment[PLAYWRIGHT_VITE_NO_HMR_ENV] = "1";
  return childEnvironment;
}
