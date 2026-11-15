import {defineConfig} from '../../../apps/browser-demos/playwright-test';
import base from '../wordpress/playwright.config';
export default defineConfig({...base,testDir:'.',testMatch:'demo.spec.ts',retries:0,workers:1});
