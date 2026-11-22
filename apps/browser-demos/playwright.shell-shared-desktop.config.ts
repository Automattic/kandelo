import { defineConfig } from './playwright-test';
import base from './playwright.config';
export default defineConfig({ ...base, testMatch: ['shell-shared-desktop.check.ts'], workers: 1,
 timeout: 360_000, use: { ...base.use, headless: true, deviceScaleFactor: 1 } });
