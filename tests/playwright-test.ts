import { test as base } from "@playwright/test";
import { withSilentAudio } from "../apps/browser-demos/playwright-audio-fixture";

// Standalone package suites use the root Playwright installation. Share the
// output policy without loading a second copy of Playwright into their runner.
export * from "@playwright/test";
export const test = withSilentAudio(base);
