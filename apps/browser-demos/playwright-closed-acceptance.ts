import {
  HOMEBREW_CLOSED_ACCEPTANCE_PLAYWRIGHT_ROOT_ENV,
  HOMEBREW_CLOSED_ACCEPTANCE_VITE_ROOT_ENV,
  homebrewClosedAcceptancePlaywrightRoot,
} from "./lib/homebrew-closed-acceptance";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Give only Playwright's managed Vite server the closed-mirror capability.
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
      key !== HOMEBREW_CLOSED_ACCEPTANCE_VITE_ROOT_ENV
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
  return childEnvironment;
}
