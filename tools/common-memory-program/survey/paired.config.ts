import {defineConfig} from '@playwright/test';
import base from '../../common-memory-prototype/playwright.config';
import {resolve} from 'node:path';
export default defineConfig({...base,testDir:'.',testMatch:'paired.spec.ts',timeout:250000,
  outputDir:resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!,'paired-playwright')});
