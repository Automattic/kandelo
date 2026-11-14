import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { browserStorageHome } from '../../apps/browser-demos/playwright-storage';
if (!process.env.KANDELO_COMMON_MEMORY_ARTIFACTS) throw Error('set KANDELO_COMMON_MEMORY_ARTIFACTS to a unique run directory');
export default defineConfig({
  testDir: '.', testMatch: 'browser.spec.ts', workers: 1, timeout: 240000,
  reporter: [['list']], outputDir: resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS, 'playwright'),
  use: { headless: true, trace: 'off' },
  projects: ['chromium', 'firefox', 'webkit'].map(name => ({ name, use: {
    browserName: name as any,
    // Reuse the repository's isolated Firefox test home (see its main
    // playwright.config.ts); this is launcher configuration, not guest code.
    ...(name === 'firefox' && process.platform === 'darwin' ? { launchOptions: {
      env: Object.fromEntries(Object.entries({ ...process.env, CFFIXED_USER_HOME: browserStorageHome('firefox') })
        .filter((entry): entry is [string, string] => entry[1] !== undefined)),
    } } : {}),
  } })),
});
