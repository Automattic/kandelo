import { test as base } from "@playwright/test";
import { withSilentAudio } from "./playwright-audio-fixture";

export * from "@playwright/test";
export type { KandeloWorkerOptions } from "./playwright-audio-fixture";
export const test = withSilentAudio(base);
