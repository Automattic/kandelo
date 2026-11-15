import { defineConfig } from '@playwright/test';
import base from '../../../common-memory-prototype/playwright.config';
export default defineConfig({ ...base, testDir: '.', testMatch: 'browser.spec.ts', timeout: 90000 });
