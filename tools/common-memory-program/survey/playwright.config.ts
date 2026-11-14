import {defineConfig} from '@playwright/test';
import base from '../../common-memory-prototype/playwright.config';
import {resolve} from 'node:path';
export default defineConfig({...base,testDir:'.',testMatch:process.env.KANDELO_SURVEY_CHECK_KIND==='platform'?'platform.spec.ts':'checks.spec.ts',
  outputDir:resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!,'playwright')});
