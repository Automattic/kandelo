import base from './playwright.config';
import {defineConfig} from '../../../apps/browser-demos/playwright-test';
export default defineConfig({...base,testMatch:'freshness.spec.ts',timeout:300000,retries:0,workers:1});
