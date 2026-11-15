import {defineConfig} from '../../../apps/browser-demos/playwright-test';
import base from '../wordpress/playwright.config';
import {resolve} from 'node:path';
export default defineConfig({...base,testDir:'.',testMatch:'browser.spec.ts',timeout:360000,retries:0,workers:1,
 outputDir:resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!,'playwright')});
