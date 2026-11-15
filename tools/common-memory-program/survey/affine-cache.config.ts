import {defineConfig} from '@playwright/test';
import base from '../../common-memory-prototype/playwright.config';
export default defineConfig({...base,testDir:'.',testMatch:'affine-cache.spec.ts',timeout:120000});
