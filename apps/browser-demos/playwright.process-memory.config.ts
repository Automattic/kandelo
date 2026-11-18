import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import base from './playwright.config';

if (process.env.KANDELO_PLAYWRIGHT_SERVE_DIST === '1'
    || process.env.KANDELO_ABI_STAGING_ASSEMBLED_SITE_ROOT !== undefined) {
  throw Error('Process-memory source fixtures cannot verify a production or assembled site');
}
const server = base.webServer;
if (!server || Array.isArray(server)) throw Error('Process-memory source fixtures require their own local server');
export default defineConfig({
  ...base,
  globalSetup: fileURLToPath(new URL('./playwright-process-memory-setup.ts', import.meta.url)),
  testMatch: 'process-address-space.spec.ts',
  webServer: {
    ...server,
    command: `npx vite --config test/fixtures/process-memory-vite.config.ts --host 127.0.0.1 --port ${server.port} --strictPort`,
  },
});
