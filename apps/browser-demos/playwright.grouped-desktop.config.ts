import { defineConfig } from './playwright-test';
import { browserStorageHome } from './playwright-storage';
export default defineConfig({ testDir: './test', testMatch: ['grouped-desktop.spec.ts', 'grouped-desktop-pressure.spec.ts', 'grouped-desktop-lifecycle.spec.ts'], workers: 1,
  timeout: 240000, reporter: 'list', outputDir: '../../.scratch/grouped-desktop-playwright',
  use: { baseURL: process.env.KANDELO_GROUPED_DESKTOP_URL ?? 'http://127.0.0.1:6209', viewport: { width: 1920, height: 1200 } },
  projects: (['chromium', 'firefox', 'webkit'] as const).map(name => ({ name, use: { browserName: name,
    ...(name === 'chromium' ? { channel: 'chromium' } : {}),
    ...(name === 'firefox' && process.platform === 'darwin' ? { launchOptions: { env:
      Object.fromEntries(Object.entries({ ...process.env, CFFIXED_USER_HOME: browserStorageHome('firefox') })
        .filter((entry): entry is [string, string] => entry[1] !== undefined)) } } : {}),
  } })),
});
