import {defineConfig} from '@playwright/test';
import base from '../../common-memory-prototype/playwright.config';
import {resolve} from 'node:path';
export default defineConfig({...base,testDir:'.',testMatch:'benchmark.spec.ts',timeout:240000,
  outputDir:resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!,'benchmark-playwright')});
