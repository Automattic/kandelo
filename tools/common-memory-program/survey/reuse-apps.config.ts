import{defineConfig}from'@playwright/test';import base from'./breadth-apps.config';
export default defineConfig({...base,testMatch:'reuse-apps.spec.ts'});
