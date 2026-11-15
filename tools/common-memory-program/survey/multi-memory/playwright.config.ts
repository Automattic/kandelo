import {defineConfig} from '@playwright/test';
import base from '../../../common-memory-prototype/playwright.config';
import {resolve} from 'node:path';
export default defineConfig({...base,testDir:'.',testMatch:'browser.spec.ts',timeout:30000,
 outputDir:resolve(process.env.KANDELO_MULTI_MEMORY_ARTIFACTS!,'playwright')});
