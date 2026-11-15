import { defineConfig } from '@playwright/test';
import base from './playwright.config';
import { resolve } from 'node:path';
export default defineConfig({ ...base, testMatch: 'optimization.spec.ts', timeout: 1200000,
  outputDir: resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!, 'optimization-playwright') });
