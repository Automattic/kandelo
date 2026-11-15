import { defineConfig } from '../../../apps/browser-demos/playwright-test';
import { browserStorageHome } from '../../../apps/browser-demos/playwright-storage';
import { resolve } from 'node:path';
if (!process.env.KANDELO_COMMON_MEMORY_ARTIFACTS) throw Error('set a unique KANDELO_COMMON_MEMORY_ARTIFACTS');
export default defineConfig({ testDir: '.', testMatch: ['smoke.spec.ts', 'memory-accounting.spec.ts'], timeout: 420000, workers: 1,
  reporter: [['list']],
  outputDir: resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!, 'playwright'),
  use: { headless: true, trace: 'retain-on-failure' },
  projects: ['chromium', 'firefox', 'webkit'].map(name => ({name, use: {
    browserName: name as 'chromium' | 'firefox' | 'webkit',
    ...(name === 'chromium' ? {channel: 'chromium'} : {}),
    ...(name === 'firefox' && process.platform === 'darwin' ? {launchOptions: {
      env: Object.fromEntries(Object.entries({...process.env, CFFIXED_USER_HOME: browserStorageHome('firefox')})
        .filter((entry): entry is [string, string] => entry[1] !== undefined)),
    }} : {}),
  }})),
});
