import {defineConfig} from '@playwright/test';
import base from '../../common-memory-prototype/playwright.config';
export default defineConfig({...base,testDir:'.',testMatch:'timestamp-stat-diagnostic.spec.ts',timeout:240000,projects:base.projects!.filter(p=>p.name==='chromium')});
